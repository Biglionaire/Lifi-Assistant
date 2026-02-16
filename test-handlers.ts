import { parseBridgeCommand, parseAgentCommand } from './src/seller/offerings/_shared/command.js';
import { chainIdOf, CHAIN_ID } from './src/seller/offerings/_shared/chains.js';
import { parseUnitsDecimal } from './src/seller/offerings/_shared/amount.js';

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log('  PASS', name);
  } catch (e: any) {
    fail++;
    console.error('  FAIL', name, '-', e.message);
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log('  PASS', name);
  } catch (e: any) {
    fail++;
    console.error('  FAIL', name, '-', e.message);
  }
}

function assert(cond: boolean, msg = '') {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}

// ==========================================
console.log('\n=== 1. _shared/chains.ts ===');
// ==========================================
test('CHAIN_ID constants', () => {
  assert(CHAIN_ID.BASE === 8453);
  assert(CHAIN_ID.ETHEREUM === 1);
  assert(CHAIN_ID.ARBITRUM === 42161);
  assert(CHAIN_ID.POLYGON === 137);
  assert(CHAIN_ID.BSC === 56);
});

test('chainIdOf valid aliases', () => {
  assert(chainIdOf('base') === 8453);
  assert(chainIdOf('eth') === 1);
  assert(chainIdOf('ethereum') === 1);
  assert(chainIdOf('arb') === 42161);
  assert(chainIdOf('arbitrum') === 42161);
  assert(chainIdOf('polygon') === 137);
  assert(chainIdOf('pol') === 137);
  assert(chainIdOf('bsc') === 56);
});

test('chainIdOf invalid returns null', () => {
  assert(chainIdOf('solana') === null);
  assert(chainIdOf('') === null);
});

// ==========================================
console.log('\n=== 2. _shared/amount.ts ===');
// ==========================================
test('parseUnitsDecimal whole number (6 dec)', () => {
  assert(parseUnitsDecimal('5', 6) === 5000000n);
});

test('parseUnitsDecimal decimal (6 dec)', () => {
  assert(parseUnitsDecimal('1.25', 6) === 1250000n);
});

test('parseUnitsDecimal decimal (18 dec)', () => {
  assert(parseUnitsDecimal('0.5', 18) === 500000000000000000n);
});

test('parseUnitsDecimal rejects negative', () => {
  try { parseUnitsDecimal('-1', 6); assert(false, 'should throw'); } catch {}
});

// ==========================================
console.log('\n=== 3. parseBridgeCommand ===');
// ==========================================
test('basic bridge command', () => {
  const r = parseBridgeCommand('bridge 5 USDC from base to arbitrum receiver 0x0000000000000000000000000000000000000001');
  assert(r.amount === '5');
  assert(r.token === 'USDC');
  assert(r.fromChain === 'base');
  assert(r.toChain === 'arbitrum');
  assert(r.receiver === '0x0000000000000000000000000000000000000001');
});

test('bridge with toToken + slippage', () => {
  const r = parseBridgeCommand('bridge 10 USDC from base to ethereum receiver 0x0000000000000000000000000000000000000001 toToken ETH slippage 1');
  assert(r.amount === '10');
  assert(r.toToken === 'ETH');
  assert(r.slippage === 1);
});

test('bridge with sender', () => {
  const r = parseBridgeCommand('bridge 5 USDC from base to arbitrum sender 0x0000000000000000000000000000000000000002 receiver 0x0000000000000000000000000000000000000001');
  assert(r.sender === '0x0000000000000000000000000000000000000002');
  assert(r.receiver === '0x0000000000000000000000000000000000000001');
});

test('reject invalid command', () => {
  try { parseBridgeCommand('send 5 USDC'); assert(false); } catch {}
});

// ==========================================
console.log('\n=== 4. parseAgentCommand ===');
// ==========================================
test('agent bridge command', () => {
  const r = parseAgentCommand('bridge 5 USDC from base to arbitrum receiver 0x0000000000000000000000000000000000000001');
  assert(r.kind === 'bridge');
  if (r.kind === 'bridge') {
    assert(r.fromChain === 'base');
    assert(r.toChain === 'arbitrum');
    assert(r.tokenIn === 'USDC');
    assert(r.tokenOut === 'USDC');
    assert(r.amount === '5');
  }
});

test('agent swap command', () => {
  const r = parseAgentCommand('swap 5 USDC to ETH on base receiver 0x0000000000000000000000000000000000000001');
  assert(r.kind === 'swap');
  if (r.kind === 'swap') {
    assert(r.chain === 'base');
    assert(r.tokenIn === 'USDC');
    assert(r.tokenOut === 'ETH');
    assert(r.amount === '5');
  }
});

test('agent swap with options', () => {
  const r = parseAgentCommand('swap 10 WETH to USDC on arbitrum receiver 0x0000000000000000000000000000000000000001 slippage 0.5 order CHEAPEST');
  assert(r.kind === 'swap');
  if (r.kind === 'swap') {
    assert(r.slippage === 0.5);
    assert(r.order === 'CHEAPEST');
  }
});

test('agent rejects garbage', () => {
  try { parseAgentCommand('hello world'); assert(false); } catch {}
});

// ==========================================
console.log('\n=== 5. lifi_bridge_executor handlers ===');
// ==========================================
const exec = await import('./src/seller/offerings/lifi_bridge_executor/handlers.js');

test('exports all 4 handlers', () => {
  assert(typeof exec.validateRequirements === 'function');
  assert(typeof exec.requestPayment === 'function');
  assert(typeof exec.requestAdditionalFunds === 'function');
  assert(typeof exec.executeJob === 'function');
});

test('validate - valid command', () => {
  const r = exec.validateRequirements({ command: 'bridge 5 USDC from base to arbitrum receiver 0x0000000000000000000000000000000000000001' });
  assert(typeof r === 'object' && 'valid' in r && r.valid === true);
});

test('validate - valid structured', () => {
  const r = exec.validateRequirements({
    amountHuman: '5', token: 'USDC', fromChain: 'base', toChain: 'ethereum',
    receiver: '0x0000000000000000000000000000000000000001'
  });
  assert(typeof r === 'object' && 'valid' in r && r.valid === true);
});

test('validate - all 4 destinations accepted', () => {
  for (const dest of ['ethereum', 'arbitrum', 'polygon', 'bsc']) {
    const r = exec.validateRequirements({
      amountHuman: '5', token: 'USDC', fromChain: 'base', toChain: dest,
      receiver: '0x0000000000000000000000000000000000000001'
    });
    assert(typeof r === 'object' && 'valid' in r && r.valid === true, `dest=${dest}`);
  }
});

test('validate - reject base as destination', () => {
  const r = exec.validateRequirements({ command: 'bridge 5 USDC from base to base receiver 0x0000000000000000000000000000000000000001' });
  assert(typeof r === 'object' && 'valid' in r && r.valid === false);
});

test('validate - reject non-base source', () => {
  const r = exec.validateRequirements({
    amountHuman: '5', token: 'USDC', fromChain: 'ethereum', toChain: 'arbitrum',
    receiver: '0x0000000000000000000000000000000000000001'
  });
  assert(typeof r === 'object' && 'valid' in r && r.valid === false);
  if (typeof r === 'object' && 'reason' in r) {
    assert(r.reason!.includes('Base'), 'should mention Base in reason');
  }
});

test('validate - reject zero amount', () => {
  const r = exec.validateRequirements({
    amountHuman: '0', token: 'USDC', fromChain: 'base', toChain: 'arbitrum',
    receiver: '0x0000000000000000000000000000000000000001'
  });
  assert(typeof r === 'object' && 'valid' in r && r.valid === false);
});

test('validate - reject invalid receiver', () => {
  const r = exec.validateRequirements({
    amountHuman: '5', token: 'USDC', fromChain: 'base', toChain: 'arbitrum',
    receiver: 'not-an-address'
  });
  assert(typeof r === 'object' && 'valid' in r && r.valid === false);
});

test('validate - reject missing toChain', () => {
  const r = exec.validateRequirements({
    amountHuman: '5', token: 'USDC', fromChain: 'base',
    receiver: '0x0000000000000000000000000000000000000001'
  });
  assert(typeof r === 'object' && 'valid' in r && r.valid === false);
});

test('validate - reject bad slippage', () => {
  const r = exec.validateRequirements({
    amountHuman: '5', token: 'USDC', fromChain: 'base', toChain: 'arbitrum',
    receiver: '0x0000000000000000000000000000000000000001', slippage: 99
  });
  assert(typeof r === 'object' && 'valid' in r && r.valid === false);
});

test('requestPayment - command input', () => {
  const r = exec.requestPayment({ command: 'bridge 5 USDC from base to arbitrum receiver 0x0000000000000000000000000000000000000001' });
  assert(typeof r === 'string');
  assert(r.includes('Base -> ARB'));
  assert(r.includes('5'));
  assert(r.includes('USDC'));
});

test('requestPayment - structured input', () => {
  const r = exec.requestPayment({
    amountHuman: '10', token: 'WETH', fromChain: 'base', toChain: 'polygon',
    receiver: '0x0000000000000000000000000000000000000001'
  });
  assert(r.includes('Base -> POL'));
  assert(r.includes('10'));
  assert(r.includes('WETH'));
});

test('requestPayment - ETH destination', () => {
  const r = exec.requestPayment({
    amountHuman: '1', token: 'USDC', fromChain: 'base', toChain: 'ethereum',
    receiver: '0x0000000000000000000000000000000000000001'
  });
  assert(r.includes('Base -> ETH'));
});

// ==========================================
console.log('\n=== 6. lifi_bridge_quote handlers ===');
// ==========================================
const quote = await import('./src/seller/offerings/lifi_bridge_quote/handlers.js');

test('quote exports', () => {
  assert(typeof quote.validateRequirements === 'function');
  assert(typeof quote.executeJob === 'function');
});

await testAsync('quote validate - bridge', async () => {
  const r = await quote.validateRequirements({ command: 'bridge 5 USDC from base to arbitrum receiver 0x0000000000000000000000000000000000000001' });
  assert(r.valid === true);
});

await testAsync('quote validate - swap', async () => {
  const r = await quote.validateRequirements({ command: 'swap 5 USDC to ETH on base receiver 0x0000000000000000000000000000000000000001' });
  assert(r.valid === true);
});

await testAsync('quote validate - reject missing command', async () => {
  const r = await quote.validateRequirements({});
  assert(r.valid === false);
});

await testAsync('quote validate - reject invalid command', async () => {
  const r = await quote.validateRequirements({ command: 'do something random' });
  assert(r.valid === false);
});

// ==========================================
console.log('\n=============================');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('=============================\n');
if (fail > 0) process.exit(1);
