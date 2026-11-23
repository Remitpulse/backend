import { createHash } from 'node:crypto'
import { Asset, BASE_FEE, Memo, Horizon, Keypair, Networks, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk'
import { atomic, db, player, record } from './store.ts'
import { parseXlm, STROOPS, xlm } from './money.ts'
import type { Command } from './game.ts'

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org')
horizon.httpClient.defaults.timeout = 8000
const options = { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
type Transfer = { hash: string; player: string; amount: string; xdr: string }
type Deposit = Transfer & { wallet: string; credited: number }

function treasury() {
  const secret = process.env.CASINO_TESTNET_TREASURY_SECRET
  if (!secret) throw new Error('The operator has not configured a Stellar Testnet treasury.')
  return Keypair.fromSecret(secret)
}

function amount(raw: unknown) {
  const value = parseXlm(raw)
  if (value <= 0n || value > 1000n * STROOPS) throw new Error('Enter a Testnet transfer amount up to 1000 XLM.')
  return value
}

function transaction(xdr: string) {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
  if (!('operations' in tx)) throw new Error('Send the original native XLM transaction.')
  return tx
}

async function settle(xdr: string, hash: string) {
  try {
    const confirmed = await horizon.transactions().transaction(hash).call()
    if (!confirmed.successful) throw new Error('The Testnet transaction failed.')
    return
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status !== 404) throw error
  }
  const confirmed = await horizon.submitTransaction(transaction(xdr))
  if (confirmed.hash !== hash) throw new Error('Unexpected Stellar transaction hash.')
}

export async function payment(id: string, input: Command) {
  const key = treasury()
  const state = player(id)!
  if (input.action === 'deposit-prepare') {
    if (input.eligible !== true) throw new Error('Confirm Testnet participation to continue.')
    if (typeof input.wallet !== 'string' || !StrKey.isValidEd25519PublicKey(input.wallet))
      throw new Error('Connect a Stellar Testnet wallet.')
    if (state.wallet && state.wallet !== input.wallet) throw new Error('Use the wallet already linked to this session.')
    const value = amount(input.amount)
    const account = await horizon.loadAccount(input.wallet).catch((error: unknown) => {
      if ((error as { response?: { status?: number } }).response?.status === 404) {
        throw new Error('This wallet has no Stellar Testnet account. Fund it with Testnet XLM, then retry.')
      }
      throw error
    })
    const tx = new TransactionBuilder(account, options)
      .addOperation(Operation.payment({ destination: key.publicKey(), asset: Asset.native(), amount: xlm(value, 0) }))
      .addMemo(Memo.text(createHash('sha256').update(id).digest('hex').slice(0, 24)))
      .setTimeout(180)
      .build()
    const hash = Buffer.from(tx.hash()).toString('hex')
    db()
      .prepare('INSERT OR IGNORE INTO deposit (hash, player, wallet, amount, xdr) VALUES (?, ?, ?, ?, ?)')
      .run(hash, id, input.wallet, value.toString(), tx.toXdr())
    return { hash, xdr: tx.toXdr() }
  }

  if (input.action === 'deposit-submit' || input.action === 'deposit-retry') {
    let envelope: string
    let hash: string
    if (input.action === 'deposit-submit') {
      if (typeof input.xdr !== 'string' || input.xdr.length > 4096) throw new Error('Sign the Testnet payment first.')
      envelope = input.xdr
      hash = Buffer.from(transaction(envelope).hash()).toString('hex')
    } else {
      if (typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) throw new Error('Choose a signed deposit.')
      const stored = db()
        .prepare(
          `
        SELECT signed_deposit.xdr FROM signed_deposit JOIN deposit USING (hash)
        WHERE hash = ? AND player = ?
      `
        )
        .get(input.hash, id)
      if (typeof stored?.xdr !== 'string') throw new Error('Signed deposit was not found.')
      envelope = stored.xdr
      hash = input.hash
    }
    const intent = db().prepare('SELECT * FROM deposit WHERE hash = ? AND player = ?').get(hash, id) as Deposit | undefined
    if (!intent) throw new Error('Payment does not match this session’s deposit request.')
    if (intent.credited) return { message: 'Deposit already credited.', hash }

    if (input.action === 'deposit-submit') {
      const signed = transaction(envelope)
      const signingKey = Keypair.fromPublicKey(intent.wallet)
      if (!signed.signatures.some(signature => signingKey.verify(signed.hash(), signature.signature))) {
        throw new Error('The connected wallet must sign this Testnet payment.')
      }
      atomic(() => {
        const linked = db()
          .prepare('UPDATE player SET wallet = ? WHERE id = ? AND (wallet IS NULL OR wallet = ?)')
          .run(intent.wallet, id, intent.wallet)
        if (!linked.changes) throw new Error('Use the wallet already linked to this session.')
        db().prepare('INSERT OR REPLACE INTO signed_deposit VALUES (?, ?)').run(hash, envelope)
      })
    }

    await settle(envelope, hash)
    atomic(() => {
      const credited = db().prepare('UPDATE deposit SET credited = 1 WHERE hash = ? AND credited = 0').run(hash)
      if (!credited.changes) return
      const value = BigInt(intent.amount)
      db().prepare('UPDATE player SET testnet = testnet + ? WHERE id = ?').run(value, id)
      record(id, 'Testnet deposit', value, hash)
    })
    return { message: 'Testnet deposit confirmed.', hash }
  }

  if (input.action !== 'withdraw' && input.action !== 'withdraw-retry') throw new Error('Choose a wallet action.')
  let pending = db().prepare('SELECT * FROM withdrawal WHERE player = ? AND pending = 1').get(id) as Transfer | undefined
  if (!pending) {
    if (input.action === 'withdraw-retry') throw new Error('There is no pending withdrawal in this session.')
    if (input.eligible !== true) throw new Error('Confirm Testnet participation to continue.')
    if (!state.wallet || input.wallet !== state.wallet) throw new Error('Connect the wallet used for your confirmed deposit.')
    const value = amount(input.amount)
    if (value > state.testnet) throw new Error('Insufficient Testnet balance.')
    const account = await horizon.loadAccount(key.publicKey())
    const tx = new TransactionBuilder(account, options)
      .addOperation(Operation.payment({ destination: state.wallet, asset: Asset.native(), amount: xlm(value, 0) }))
      .setTimeout(3600)
      .build()
    tx.sign(key)
    const hash = Buffer.from(tx.hash()).toString('hex')
    const envelope = tx.toXdr()
    atomic(() => {
      if (db().prepare('SELECT hash FROM withdrawal WHERE pending = 1').get())
        throw new Error('The treasury is settling another withdrawal.')
      const reserved = db().prepare('UPDATE player SET testnet = testnet - ? WHERE id = ? AND testnet >= ?').run(value, id, value)
      if (!reserved.changes) throw new Error('Insufficient Testnet balance.')
      db().prepare('INSERT INTO withdrawal (hash, player, amount, xdr) VALUES (?, ?, ?, ?)').run(hash, id, value.toString(), envelope)
      record(id, 'Withdrawal reserved', -value, hash)
    })
    pending = { hash, player: id, amount: value.toString(), xdr: envelope }
  }
  const transfer = pending
  try {
    await settle(transfer.xdr, transfer.hash)
  } catch {
    throw new Error('Withdrawal is reserved, awaiting Testnet confirmation. Retry confirmation from the wallet panel.')
  }
  atomic(() => {
    if (db().prepare('UPDATE withdrawal SET pending = 0 WHERE hash = ? AND pending = 1').run(transfer.hash).changes) {
      record(id, 'Testnet withdrawal confirmed', 0n, transfer.hash)
    }
  })
  return { message: 'Testnet withdrawal confirmed.', hash: transfer.hash }
}

export async function treasuryBalance() {
  if (!process.env.CASINO_TESTNET_TREASURY_SECRET) return null
  const account = await horizon.loadAccount(treasury().publicKey())
  const native = account.balances.find(balance => balance.asset_type === 'native')
  return native ? parseXlm(native.balance).toString() : null
}
