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

export async function testnetTransferStatus(hash: string) {
  try {
    const receipt = await horizon.transactions().transaction(hash).call()
    if (receipt.hash !== hash || typeof receipt.successful !== 'boolean' ||
        !Number.isSafeInteger(receipt.ledger_attr) || receipt.ledger_attr <= 0) {
      throw new Error('Horizon returned an incomplete or mismatched transfer receipt.')
    }
    return { status: receipt.successful ? 'confirmed' : 'failed', ledger: receipt.ledger_attr }
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status === 404) {
      return { status: 'not-found', ledger: null }
    }
    throw error
  }
}

async function settle(xdr: string, hash: string) {
  const receipt = await testnetTransferStatus(hash)
  if (receipt.status !== 'not-found') return receipt.status
  const confirmed = await horizon.submitTransaction(transaction(xdr))
  if (confirmed.hash !== hash) throw new Error('Unexpected Stellar transaction hash.')
  return 'confirmed'
}

export async function walletBalance(wallet: unknown) {
  if (typeof wallet !== 'string' || !StrKey.isValidEd25519PublicKey(wallet)) {
    throw new Error('Connect a Stellar Testnet wallet.')
  }
  try {
    const account = await horizon.loadAccount(wallet)
    const native = account.balances.find(balance => balance.asset_type === 'native')
    return { walletBalance: { funded: true, stroops: native ? parseXlm(native.balance).toString() : '0' } }
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status === 404) {
      return { walletBalance: { funded: false, stroops: '0' } }
    }
    throw error
  }
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
    const failure = { message: 'Stellar Testnet recorded this deposit as failed. Start a new deposit.', hash }
    if (db().prepare('SELECT hash FROM failed_deposit WHERE hash = ?').get(hash)) return failure

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

    if (await settle(envelope, hash) === 'failed') {
      markFailedDeposit(hash)
      return failure
    }
    creditDeposit(intent)
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
  let outcome: Awaited<ReturnType<typeof settle>>
  try {
    outcome = await settle(transfer.xdr, transfer.hash)
  } catch {
    throw new Error('Withdrawal is reserved, awaiting Testnet confirmation. Retry confirmation from the wallet panel.')
  }
  if (outcome === 'failed') {
    releaseFailedWithdrawal(transfer)
    return { message: 'Testnet withdrawal failed. The reserved XLM was returned to your balance.', hash: transfer.hash }
  }
  confirmWithdrawal(transfer)
  return { message: 'Testnet withdrawal confirmed.', hash: transfer.hash }
}

function creditDeposit(intent: Deposit) {
  return atomic(() => {
    const credited = db().prepare('UPDATE deposit SET credited = 1 WHERE hash = ? AND credited = 0').run(intent.hash)
    if (!credited.changes) return false
    const value = BigInt(intent.amount)
    db().prepare('UPDATE player SET testnet = testnet + ? WHERE id = ?').run(value, intent.player)
    record(intent.player, 'Testnet deposit', value, intent.hash)
    return true
  })
}

function confirmWithdrawal(transfer: Transfer) {
  return atomic(() => {
    const confirmed = db().prepare('UPDATE withdrawal SET pending = 0 WHERE hash = ? AND pending = 1').run(transfer.hash)
    if (!confirmed.changes) return false
    record(transfer.player, 'Testnet withdrawal confirmed', 0n, transfer.hash)
    return true
  })
}

function releaseFailedWithdrawal(transfer: Transfer) {
  return atomic(() => {
    const released = db().prepare('UPDATE withdrawal SET pending = 0 WHERE hash = ? AND pending = 1').run(transfer.hash)
    if (!released.changes) return false
    const value = BigInt(transfer.amount)
    db().prepare('UPDATE player SET testnet = testnet + ? WHERE id = ?').run(value, transfer.player)
    record(transfer.player, 'Failed Testnet withdrawal released', value, transfer.hash)
    return true
  })
}

function markFailedDeposit(hash: string) {
  return db().prepare('INSERT OR IGNORE INTO failed_deposit VALUES (?, ?)').run(hash, new Date().toISOString()).changes > 0
}

export async function reconcileTestnetTransfer(hash: string, lookup = testnetTransferStatus) {
  const deposit = db().prepare(
    'SELECT deposit.* FROM deposit JOIN signed_deposit USING (hash) WHERE hash = ?',
  ).get(hash) as Deposit | undefined
  const withdrawal = db().prepare('SELECT * FROM withdrawal WHERE hash = ?').get(hash) as
    (Transfer & { pending: number }) | undefined
  if (!deposit && !withdrawal) throw new Error('No signed or reserved transfer matches this hash.')
  if (deposit?.credited || withdrawal?.pending === 0 ||
      db().prepare('SELECT hash FROM failed_deposit WHERE hash = ?').get(hash)) {
    return { message: 'The transfer is already reconciled.' }
  }

  const receipt = await lookup(hash)
  if (deposit && receipt.status === 'failed') {
    const marked = markFailedDeposit(hash)
    return { message: marked ? 'Failed deposit closed without credit.' : 'The transfer is already reconciled.' }
  }
  if (withdrawal && receipt.status === 'failed') {
    const released = releaseFailedWithdrawal(withdrawal)
    return { message: released ? 'Failed withdrawal reserve returned to the player.' : 'The transfer is already reconciled.' }
  }
  if (receipt.status !== 'confirmed') throw new Error('Reconciliation requires a confirmed Testnet receipt.')
  const changed = deposit ? creditDeposit(deposit) : confirmWithdrawal(withdrawal!)
  return { message: changed ? 'Confirmed transfer reconciled.' : 'The transfer is already reconciled.' }
}

export async function treasuryBalance() {
  if (!process.env.CASINO_TESTNET_TREASURY_SECRET) return null
  const account = await horizon.loadAccount(treasury().publicKey())
  const native = account.balances.find(balance => balance.asset_type === 'native')
  return native ? parseXlm(native.balance).toString() : null
}
