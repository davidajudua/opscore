/**
 * Crypto transaction lookup. Supports BTC, ETH, LTC, SOL, TRX, BSC, BASE, ARB, POLY.
 * Ported from the standalone Payment Bot's blockchain.js (CommonJS → ESM).
 *
 * Public surface:
 *   parseTransactionInput(input) → { coin, hash, autoDetect? } | null
 *   fetchTransaction(coin, hash, addressList, autoDetect?) → tx data with USD prices
 */

const EXPLORER_PATTERNS = [
  // BTC
  { coin: 'BTC', re: /(?:blockchain\.com\/(?:btc|bitcoin)\/tx|blockchain\.com\/explorer\/transactions\/btc|blockstream\.info\/tx|mempool\.space\/tx|btcscan\.org\/tx|live\.blockcypher\.com\/btc\/tx|chain\.so\/tx\/BTC|oxt\.me\/transaction|blockchair\.com\/bitcoin\/transaction)\/([a-fA-F0-9]{64})/i },
  // ETH
  { coin: 'ETH', re: /(?:etherscan\.io\/tx|ethplorer\.io\/tx|eth\.blockscout\.com\/tx|etherchain\.org\/tx|blockchain\.com\/(?:eth\/tx|explorer\/transactions\/eth)|blockchair\.com\/ethereum\/transaction)\/([a-fA-F0-9x]{66})/i },
  // LTC
  { coin: 'LTC', re: /(?:blockchair\.com\/litecoin\/transaction|litecoinspace\.org\/tx|live\.blockcypher\.com\/ltc\/tx|chain\.so\/tx\/LTC|sochain\.com\/tx\/LTC)\/([a-fA-F0-9]{64})/i },
  // SOL
  { coin: 'SOL', re: /(?:solscan\.io\/tx|explorer\.solana\.com\/tx|solana\.fm\/tx|solanabeach\.io\/transaction|xray\.helius\.xyz\/tx|orbmarkets\.io\/tx)\/([1-9A-HJ-NP-Za-km-z]{43,88})/i },
  // TRX
  { coin: 'TRX', re: /tronscan\.(?:org|io)\/#\/transaction\/([a-fA-F0-9]{64})/i },
  { coin: 'TRX', re: /tronscan\.(?:org|io)\/transaction\/([a-fA-F0-9]{64})/i },
  // BSC
  { coin: 'BSC', re: /(?:bscscan\.com\/tx|blockchair\.com\/bnb\/transaction)\/([a-fA-F0-9x]{66})/i },
  // BASE
  { coin: 'BASE', re: /basescan\.org\/tx\/([a-fA-F0-9x]{66})/i },
  // ARB
  { coin: 'ARB', re: /arbiscan\.io\/tx\/([a-fA-F0-9x]{66})/i },
  // POLY
  { coin: 'POLY', re: /polygonscan\.com\/tx\/([a-fA-F0-9x]{66})/i },
  // Raw prefix format
  { coin: 'BTC',  re: /^btc:([a-fA-F0-9]{64})$/i },
  { coin: 'ETH',  re: /^eth:(0x[a-fA-F0-9]{64})$/i },
  { coin: 'LTC',  re: /^ltc:([a-fA-F0-9]{64})$/i },
  { coin: 'SOL',  re: /^sol:([1-9A-HJ-NP-Za-km-z]{43,88})$/i },
  { coin: 'TRX',  re: /^trx:([a-fA-F0-9]{64})$/i },
  { coin: 'BSC',  re: /^bsc:(0x[a-fA-F0-9]{64})$/i },
  { coin: 'BASE', re: /^base:(0x[a-fA-F0-9]{64})$/i },
  { coin: 'ARB',  re: /^arb:(0x[a-fA-F0-9]{64})$/i },
  { coin: 'POLY', re: /^poly:(0x[a-fA-F0-9]{64})$/i },
];

export function parseTransactionInput(input) {
  const trimmed = String(input ?? '').trim();
  for (const { coin, re } of EXPLORER_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return { coin, hash: m[1] };
  }
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return { coin: null, hash: trimmed, autoDetect: 'hex64' };
  }
  if (/^0x[a-fA-F0-9]{64}$/i.test(trimmed)) {
    return { coin: null, hash: trimmed, autoDetect: '0x' };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(trimmed)) {
    return { coin: 'SOL', hash: trimmed };
  }
  return null;
}

/* ------------------------------------------------------------ price helpers */

const CRYPTO_SYMBOLS = {
  BTC: 'BTC',  ETH: 'ETH',  LTC: 'LTC',
  SOL: 'SOL',  TRX: 'TRX',  BSC: 'BNB',
  BASE: 'ETH', ARB: 'ETH',  POLY: 'MATIC',
};

const COINGECKO_IDS = {
  BTC: 'bitcoin',  ETH: 'ethereum',     LTC: 'litecoin',
  SOL: 'solana',   TRX: 'tron',         BSC: 'binancecoin',
  BASE: 'ethereum', ARB: 'ethereum',    POLY: 'matic-network',
};

const priceCache = {};
const CURRENT_CACHE_TTL = 2 * 60 * 1000;
const HISTORY_CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const entry = priceCache[key];
  if (!entry) return undefined;
  if (Date.now() - entry.time > entry.ttl) { delete priceCache[key]; return undefined; }
  return entry.value;
}

function setCache(key, value, ttl) {
  const now = Date.now();
  // Sweep expired entries so historical-price keys (unique per timestamp) can't
  // accumulate without bound in a long-running process.
  for (const k in priceCache) {
    if (now - priceCache[k].time > priceCache[k].ttl) delete priceCache[k];
  }
  priceCache[key] = { value, time: now, ttl };
}

async function getCurrentPrice(coin) {
  const sym = CRYPTO_SYMBOLS[coin];
  if (!sym) return null;
  const cacheKey = `current_${sym}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`https://min-api.cryptocompare.com/data/price?fsym=${sym}&tsyms=USD`);
    if (res.ok) {
      const data = await res.json();
      if (data.USD) { setCache(cacheKey, data.USD, CURRENT_CACHE_TTL); return data.USD; }
    }
  } catch {}

  try {
    const id = COINGECKO_IDS[coin];
    if (!id) return null;
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (res.ok) {
      const data = await res.json();
      const price = data[id]?.usd ?? null;
      if (price != null) setCache(cacheKey, price, CURRENT_CACHE_TTL);
      return price;
    }
  } catch {}

  return null;
}

async function getHistoricalPrice(coin, dateMs) {
  const sym = CRYPTO_SYMBOLS[coin];
  if (!sym) return null;
  const ts = Math.floor(dateMs / 1000);
  const cacheKey = `history_${sym}_${ts}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=${sym}&tsym=USD&limit=1&toTs=${ts}`);
    if (res.ok) {
      const data = await res.json();
      const price = data?.Data?.Data?.[1]?.close ?? data?.Data?.Data?.[0]?.close ?? null;
      if (price) { setCache(cacheKey, price, HISTORY_CACHE_TTL); return price; }
    }
  } catch {}

  try {
    const d = new Date(dateMs);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const id = COINGECKO_IDS[coin];
    if (!id) return null;
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/history?date=${dd}-${mm}-${yyyy}&localization=false`);
    if (res.ok) {
      const data = await res.json();
      const price = data?.market_data?.current_price?.usd ?? null;
      if (price != null) setCache(cacheKey, price, HISTORY_CACHE_TTL);
      return price;
    }
  } catch {}

  return null;
}

async function getTokenPrice(contractAddress, platform = 'ethereum') {
  const cacheKey = `token_${platform}_${contractAddress.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${contractAddress}&vs_currencies=usd`);
    if (res.ok) {
      const data = await res.json();
      const price = data?.[contractAddress.toLowerCase()]?.usd ?? null;
      if (price != null) { setCache(cacheKey, price, CURRENT_CACHE_TTL); return price; }
    }
  } catch {}
  return null;
}

/* ------------------------------------------------------------ chain fetchers */

function normList(addresses) {
  return addresses.filter(Boolean).map((a) => a.toLowerCase());
}

/**
 * Confirmations for a BTC tx = (chain tip height − inclusion block height + 1).
 * NOT the inclusion block height itself. Returns 0 when unconfirmed or when the
 * tip height is unavailable. Pure function.
 */
export function btcConfirmations(tipHeight, blockHeight, confirmed) {
  if (!confirmed || blockHeight == null) return 0;
  if (!Number.isFinite(tipHeight)) return 0;
  return Math.max(0, tipHeight - blockHeight + 1);
}

async function fetchBTC(hash, myAddresses) {
  const url = `https://mempool.space/api/tx/${hash}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mempool.space BTC error ${res.status}`);
  const tx = await res.json();

  // Fetch the current chain tip so confirmations are a real count, not the block height.
  let tipHeight = null;
  try {
    const tipRes = await fetch('https://mempool.space/api/blocks/tip/height');
    if (tipRes.ok) tipHeight = parseInt(await tipRes.text(), 10);
  } catch {
    /* tip unavailable → confirmations falls back to 0 */
  }

  const timestamp = tx.status?.block_time ? tx.status.block_time * 1000 : Date.now();
  const confirmations = btcConfirmations(tipHeight, tx.status?.block_height, tx.status?.confirmed);

  const outputs = tx.vout ?? [];
  const myNorms = normList(myAddresses);

  let target = myNorms.length > 0
    ? outputs.find((o) => myNorms.includes(o.scriptpubkey_address?.toLowerCase()))
    : null;
  if (!target) target = [...outputs].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];

  const amountBTC = target ? target.value / 1e8 : null;
  const toAddress = target?.scriptpubkey_address ?? 'Unknown';

  return { coin: 'BTC', hash, amountNative: amountBTC, unit: 'BTC', toAddress, timestamp, confirmations };
}

const ETH_KNOWN_TOKENS = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',  decimals: 18 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
};

const BSC_KNOWN_TOKENS = {
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18 },
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18 },
};

async function fetchEVMBlockchair(blockchairChain, coin, nativeUnit, hash, myAddresses, knownTokens) {
  const h = hash.startsWith('0x') ? hash : '0x' + hash;
  const url = `https://api.blockchair.com/${blockchairChain}/dashboards/transaction/${h}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Blockchair ${coin} error ${res.status}`);
  const json = await res.json();

  const dataKeys = Object.keys(json?.data || {});
  const txData = json?.data?.[h] ?? json?.data?.[h.toLowerCase()] ?? (dataKeys.length > 0 ? json.data[dataKeys[0]] : null);
  if (!txData) throw new Error('Transaction not found.');

  const tx = txData.transaction;
  const calls = txData.calls ?? [];

  const timestamp = tx.time ? new Date(tx.time + ' UTC').getTime() : null;
  // +1 so a freshly-mined tx reports 1 confirmation (matching btcConfirmations/evmConfirmations).
  const confirmations = tx.block_id ? Math.max(0, (json.context?.state ?? 0) - tx.block_id + 1) : 0;

  let amountNative = (tx.value ?? 0) / 1e18;
  let toAddress = tx.recipient ?? 'Unknown';
  let unit = nativeUnit;
  let tokenAddress = null;
  const myNorms = normList(myAddresses);

  function decodeERC20Transfer(call) {
    const inp = call.input_hex ?? '';
    if (inp.startsWith('a9059cbb')) {
      const data = inp.slice(8);
      if (data.length < 128) return null;
      const recipientHex = data.slice(24, 64);
      const amountHex = data.slice(64, 128);
      const recipient = '0x' + recipientHex;
      const amount = BigInt('0x' + amountHex);
      const token = knownTokens[call.recipient?.toLowerCase()];
      return { recipient, amount, token, contractAddress: call.recipient };
    }
    if (inp.startsWith('23b872dd')) {
      const data = inp.slice(8);
      if (data.length < 192) return null;
      const recipientHex = data.slice(88, 128);
      const amountHex = data.slice(128, 192);
      const recipient = '0x' + recipientHex;
      const amount = BigInt('0x' + amountHex);
      const token = knownTokens[call.recipient?.toLowerCase()];
      return { recipient, amount, token, contractAddress: call.recipient };
    }
    return null;
  }

  if (amountNative === 0) {
    for (const call of calls) {
      const decoded = decodeERC20Transfer(call);
      if (!decoded) continue;
      const recipientNorm = decoded.recipient.toLowerCase();
      if (myNorms.length > 0 && !myNorms.includes(recipientNorm)) continue;
      const decimals = decoded.token?.decimals ?? 18;
      amountNative = Number(decoded.amount) / Math.pow(10, decimals);
      toAddress = '0x' + decoded.recipient.slice(2);
      unit = decoded.token?.symbol ?? 'TOKEN';
      tokenAddress = decoded.contractAddress ?? null;
      break;
    }
  }

  if (tokenAddress === null && amountNative === 0 && calls.length > 0) {
    let best = myNorms.length > 0
      ? calls.find((c) => myNorms.includes(c.recipient?.toLowerCase()) && Number(c.value ?? 0) > 0)
      : null;
    if (!best) best = calls.filter((c) => Number(c.value ?? 0) > 0).sort((a, b) => Number(b.value) - Number(a.value))[0] ?? null;
    if (best) {
      amountNative = Number(best.value) / 1e18;
      toAddress = best.recipient ?? toAddress;
    }
  }

  if (tokenAddress === null && amountNative === 0) {
    for (const call of calls) {
      const decoded = decodeERC20Transfer(call);
      if (!decoded) continue;
      const decimals = decoded.token?.decimals ?? 18;
      amountNative = Number(decoded.amount) / Math.pow(10, decimals);
      toAddress = decoded.recipient;
      unit = decoded.token?.symbol ?? 'TOKEN';
      tokenAddress = decoded.contractAddress ?? null;
      break;
    }
  }

  const tokenPlatform = blockchairChain === 'ethereum' ? 'ethereum' : 'binance-smart-chain';
  return { coin, hash: h, amountNative, unit, toAddress, timestamp, confirmations, tokenAddress, tokenPlatform };
}

async function fetchETH(hash, myAddresses) {
  return fetchEVMBlockchair('ethereum', 'ETH', 'ETH', hash, myAddresses, ETH_KNOWN_TOKENS);
}

async function fetchBSC(hash, myAddresses) {
  return fetchEVMBlockchair('binance-smart-chain', 'BSC', 'BNB', hash, myAddresses, BSC_KNOWN_TOKENS);
}

const BASE_KNOWN_TOKENS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI',  decimals: 18 },
};

const ARB_KNOWN_TOKENS = {
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI',  decimals: 18 },
};

const POLY_KNOWN_TOKENS = {
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WMATIC', decimals: 18 },
};

const EVM_RPC_CHAINS = {
  BASE: { rpcUrl: 'https://mainnet.base.org',     nativeUnit: 'ETH',   tokenPlatform: 'base',         knownTokens: BASE_KNOWN_TOKENS },
  ARB:  { rpcUrl: 'https://arb1.arbitrum.io/rpc', nativeUnit: 'ETH',   tokenPlatform: 'arbitrum-one', knownTokens: ARB_KNOWN_TOKENS },
  POLY: { rpcUrl: 'https://polygon-rpc.com',      nativeUnit: 'MATIC', tokenPlatform: 'polygon-pos',  knownTokens: POLY_KNOWN_TOKENS },
};

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC error ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC: ${data.error.message}`);
  return data;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Confirmations for an EVM tx. A pending tx has a null blockNumber → 0 confirmations
 * (never NaN). Otherwise (currentBlock − inclusionBlock + 1). Pure function.
 */
export function evmConfirmations(currentBlock, txBlockNumberHex) {
  if (txBlockNumberHex == null) return 0;
  const txBlock = parseInt(txBlockNumberHex, 16);
  if (!Number.isFinite(currentBlock) || !Number.isFinite(txBlock)) return 0;
  return Math.max(0, currentBlock - txBlock + 1);
}

async function fetchEVMRpc(coin, hash, myAddresses) {
  const chain = EVM_RPC_CHAINS[coin];
  if (!chain) throw new Error(`No RPC config for ${coin}`);
  const h = hash.startsWith('0x') ? hash : '0x' + hash;

  const [txRes, receiptRes, blockNumRes] = await Promise.all([
    rpcCall(chain.rpcUrl, 'eth_getTransactionByHash', [h]),
    rpcCall(chain.rpcUrl, 'eth_getTransactionReceipt', [h]),
    rpcCall(chain.rpcUrl, 'eth_blockNumber', []),
  ]);

  const tx = txRes.result;
  const receipt = receiptRes.result;
  if (!tx) throw new Error('Transaction not found.');

  const currentBlock = parseInt(blockNumRes.result, 16);
  // Pending transactions have a null blockNumber — guard so confirmations is 0,
  // not NaN, and skip the (invalid) block lookup for a null block number.
  const isPending = tx.blockNumber == null;
  const confirmations = evmConfirmations(currentBlock, tx.blockNumber);

  let timestamp = null;
  if (!isPending) {
    const blockRes = await rpcCall(chain.rpcUrl, 'eth_getBlockByNumber', [tx.blockNumber, false]);
    timestamp = blockRes.result?.timestamp ? parseInt(blockRes.result.timestamp, 16) * 1000 : null;
  }

  let amountNative = parseInt(tx.value, 16) / 1e18;
  let toAddress = tx.to || 'Unknown';
  let unit = chain.nativeUnit;
  let tokenAddress = null;
  const myNorms = normList(myAddresses);

  if (receipt?.logs && amountNative === 0) {
    const transferLogs = receipt.logs.filter(
      (log) => log.topics?.[0] === TRANSFER_TOPIC && log.topics.length >= 3,
    );
    for (const log of transferLogs) {
      const to = '0x' + log.topics[2].slice(26);
      if (myNorms.length > 0 && !myNorms.includes(to.toLowerCase())) continue;
      const contractAddr = log.address.toLowerCase();
      const token = chain.knownTokens[contractAddr];
      const decimals = token?.decimals ?? 18;
      const amount = BigInt(log.data);
      amountNative = Number(amount) / Math.pow(10, decimals);
      toAddress = to;
      unit = token?.symbol ?? 'TOKEN';
      tokenAddress = log.address;
      break;
    }
    if (tokenAddress === null && amountNative === 0 && transferLogs.length > 0) {
      const log = transferLogs[0];
      const to = '0x' + log.topics[2].slice(26);
      const contractAddr = log.address.toLowerCase();
      const token = chain.knownTokens[contractAddr];
      const decimals = token?.decimals ?? 18;
      const amount = BigInt(log.data);
      amountNative = Number(amount) / Math.pow(10, decimals);
      toAddress = to;
      unit = token?.symbol ?? 'TOKEN';
      tokenAddress = log.address;
    }
  }

  return { coin, hash: h, amountNative, unit, toAddress, timestamp, confirmations, tokenAddress, tokenPlatform: chain.tokenPlatform };
}

async function fetchLTC(hash, myAddresses) {
  const url = `https://api.blockcypher.com/v1/ltc/main/txs/${hash}?limit=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BlockCypher LTC error ${res.status}: ${await res.text()}`);
  const tx = await res.json();

  const confirmedTime = tx.confirmed ? new Date(tx.confirmed).getTime() : null;
  const receivedTime = tx.received ? new Date(tx.received).getTime() : null;
  const timestamp = confirmedTime ?? receivedTime;

  const outputs = tx.outputs || [];
  const myNorms = normList(myAddresses);

  let targetOutput = myNorms.length > 0
    ? outputs.find((o) => o.addresses?.some((a) => myNorms.includes(a.toLowerCase())))
    : null;
  if (!targetOutput) targetOutput = outputs[0];

  const amountLTC = targetOutput ? targetOutput.value / 1e8 : null;
  const toAddress = targetOutput?.addresses?.[0] ?? 'Unknown';

  return { coin: 'LTC', hash, amountNative: amountLTC, unit: 'LTC', toAddress, timestamp, confirmations: tx.confirmations ?? 0 };
}

const SOL_KNOWN_TOKENS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT' },
};

/**
 * Extract a native-SOL transfer from a parsed Solana transaction.
 * Two-pass: (1) a balance change on one of my addresses; (2) the largest positive delta.
 * Pure function of (tx, myAddresses) — no network.
 */
export function extractSolNativeTransfer(tx, myAddresses) {
  const accounts = tx.transaction?.message?.accountKeys ?? [];
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];

  for (const myAddr of myAddresses.filter(Boolean)) {
    const idx = accounts.findIndex((a) => (typeof a === 'string' ? a : a.pubkey) === myAddr);
    if (idx !== -1 && post[idx] !== undefined && pre[idx] !== undefined) {
      const delta = post[idx] - pre[idx];
      // Only an INBOUND transfer (balance increased) counts as income. If our
      // address is the sender, delta is negative — skip and fall through to the
      // largest positive delta (the real recipient) instead of reporting a negative.
      if (delta > 0) {
        return { amountNative: delta / 1e9, unit: 'SOL', toAddress: myAddr };
      }
    }
  }

  let maxDelta = 0;
  let amountNative = null;
  let toAddress = 'Unknown';
  for (let i = 1; i < accounts.length; i++) {
    const delta = (post[i] ?? 0) - (pre[i] ?? 0);
    if (delta > maxDelta) {
      maxDelta = delta;
      amountNative = delta / 1e9;
      toAddress = typeof accounts[i] === 'string' ? accounts[i] : accounts[i].pubkey;
    }
  }
  return { amountNative, unit: 'SOL', toAddress };
}

/**
 * Extract an SPL token transfer from a parsed Solana transaction by diffing
 * pre/postTokenBalances per token account. Two-pass like the native path:
 * (1) a positive delta owned by one of my addresses; (2) the largest positive delta.
 * Pure function of (tx, myAddresses) — no network.
 */
export function extractSolTokenTransfer(tx, myAddresses) {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const deltas = [];
  for (const p of post) {
    const preEntry = pre.find((e) => e.accountIndex === p.accountIndex);
    const preRaw = BigInt(preEntry?.uiTokenAmount?.amount ?? '0');
    const postRaw = BigInt(p.uiTokenAmount?.amount ?? '0');
    const diff = postRaw - preRaw;
    if (diff > 0n) {
      const decimals = p.uiTokenAmount?.decimals ?? 0;
      deltas.push({ owner: p.owner, mint: p.mint, amount: Number(diff) / 10 ** decimals });
    }
  }

  if (deltas.length === 0) {
    return { amountNative: null, unit: 'TOKEN', toAddress: 'Unknown' };
  }

  const mine = new Set(myAddresses.filter(Boolean));
  let chosen = deltas.filter((d) => mine.has(d.owner)).sort((a, b) => b.amount - a.amount)[0];
  if (!chosen) chosen = deltas.slice().sort((a, b) => b.amount - a.amount)[0];

  const known = SOL_KNOWN_TOKENS[chosen.mint];
  return {
    amountNative: chosen.amount,
    unit: known ? known.symbol : 'TOKEN',
    toAddress: chosen.owner,
    tokenAddress: chosen.mint,
    tokenPlatform: 'solana',
  };
}

async function fetchSOL(hash, myAddresses) {
  const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [hash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
  });

  let res;
  for (const rpc of RPCS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) break;
    } catch {
      clearTimeout(timeout);
      continue;
    }
  }
  if (!res || !res.ok) throw new Error('All Solana RPCs failed. Try again shortly.');
  const data = await res.json();
  if (data.error) throw new Error(`Solana RPC: ${data.error.message}`);

  const tx = data.result;
  if (!tx) throw new Error('Transaction not found on Solana mainnet.');

  const timestamp = tx.blockTime ? tx.blockTime * 1000 : null;
  const confirmations = tx.meta?.confirmationStatus === 'finalized' ? 'Finalized' : 'Pending';

  const hasTokenBalances =
    (tx.meta?.preTokenBalances?.length ?? 0) > 0 ||
    (tx.meta?.postTokenBalances?.length ?? 0) > 0;

  const extracted = hasTokenBalances
    ? extractSolTokenTransfer(tx, myAddresses)
    : extractSolNativeTransfer(tx, myAddresses);

  return { coin: 'SOL', hash, timestamp, confirmations, ...extracted };
}

async function fetchTRON(hash, myAddresses) {
  const url = `https://apilist.tronscan.org/api/transaction-info?hash=${hash}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tronscan error ${res.status}`);
  const tx = await res.json();
  if (!tx.hash) throw new Error('Transaction not found on TRON network.');

  const timestamp = tx.timestamp || null;
  const confirmed = tx.confirmed;
  const myNorms = normList(myAddresses);

  let amountNative = null;
  let toAddress = 'Unknown';
  let unit = 'TRX';
  let tokenAddress = null;

  const trc20 = tx.trc20TransferInfo || tx.tokenTransferInfo || [];
  if (trc20.length > 0) {
    let transfer = myNorms.length > 0
      ? trc20.find((t) => myNorms.includes(t.to_address?.toLowerCase()))
      : null;
    if (!transfer) transfer = trc20[0];
    const decimals = transfer.decimals ?? 6;
    amountNative = Number(transfer.amount_str || transfer.amount || 0) / Math.pow(10, decimals);
    toAddress = transfer.to_address || 'Unknown';
    unit = transfer.symbol || 'TOKEN';
    tokenAddress = transfer.contract_address || null;
  } else {
    const contractData = tx.contractData || {};
    amountNative = (contractData.amount || 0) / 1e6;
    toAddress = contractData.to_address || tx.toAddress || 'Unknown';
  }

  return {
    coin: 'TRX',
    hash,
    amountNative,
    unit,
    toAddress,
    timestamp,
    confirmations: confirmed ? 'Confirmed' : 'Pending',
    tokenAddress,
    tokenPlatform: 'tron',
  };
}

/* ------------------------------------------------------------ auto-detect */

async function tryFetch(fn) {
  try { return await fn(); } catch { return null; }
}

async function autoDetectHex64(hash, addrs) {
  const [btc, ltc, trx] = await Promise.all([
    tryFetch(() => fetchBTC(hash, addrs)),
    tryFetch(() => fetchLTC(hash, addrs)),
    tryFetch(() => fetchTRON(hash, addrs)),
  ]);
  return btc || ltc || trx || null;
}

async function autoDetect0x(hash, addrs) {
  const [eth, bsc, base, arb, poly] = await Promise.all([
    tryFetch(() => fetchETH(hash, addrs)),
    tryFetch(() => fetchBSC(hash, addrs)),
    tryFetch(() => fetchEVMRpc('BASE', hash, addrs)),
    tryFetch(() => fetchEVMRpc('ARB', hash, addrs)),
    tryFetch(() => fetchEVMRpc('POLY', hash, addrs)),
  ]);
  return eth || bsc || base || arb || poly || null;
}

/* ------------------------------------------------------------ main */

export async function fetchTransaction(coin, hash, addressList, autoDetect) {
  const addrs = addressList || [];
  let txData;

  if (!coin && autoDetect === 'hex64') {
    txData = await autoDetectHex64(hash, addrs);
    if (!txData) throw new Error('Transaction not found on BTC, LTC, or TRX networks.');
  } else if (!coin && autoDetect === '0x') {
    txData = await autoDetect0x(hash, addrs);
    if (!txData) throw new Error('Transaction not found on ETH, BSC, Base, Arbitrum, or Polygon.');
  } else {
    switch (coin) {
      case 'BTC':  txData = await fetchBTC(hash, addrs); break;
      case 'ETH':  txData = await fetchETH(hash, addrs); break;
      case 'LTC':  txData = await fetchLTC(hash, addrs); break;
      case 'SOL':  txData = await fetchSOL(hash, addrs); break;
      case 'TRX':  txData = await fetchTRON(hash, addrs); break;
      case 'BSC':  txData = await fetchBSC(hash, addrs); break;
      case 'BASE':
      case 'ARB':
      case 'POLY':
        txData = await fetchEVMRpc(coin, hash, addrs); break;
      default: throw new Error(`Unsupported coin: ${coin}`);
    }
  }

  coin = txData.coin;
  let currentPrice;
  let historicalPrice;

  if (txData.tokenAddress) {
    const stables = ['usdc', 'usdt', 'dai', 'busd', 'frax', 'tusd', 'usdbc'];
    const isStable = stables.includes(txData.unit?.toLowerCase());
    if (isStable) {
      currentPrice = 1;
      historicalPrice = 1;
    } else {
      const platform = txData.tokenPlatform || 'ethereum';
      currentPrice = await getTokenPrice(txData.tokenAddress, platform).catch(() => null);
      historicalPrice = currentPrice;
    }
  } else {
    [currentPrice, historicalPrice] = await Promise.all([
      getCurrentPrice(coin).catch(() => null),
      txData.timestamp ? getHistoricalPrice(coin, txData.timestamp).catch(() => null) : Promise.resolve(null),
    ]);
  }

  return { ...txData, currentPrice, historicalPrice };
}

/* ------------------------------------------------------------ explorer URLs */

export const EXPLORER_BASES = {
  BTC:  'https://mempool.space/tx/',
  ETH:  'https://etherscan.io/tx/',
  LTC:  'https://litecoinspace.org/tx/',
  SOL:  'https://solscan.io/tx/',
  TRX:  'https://tronscan.org/#/transaction/',
  BSC:  'https://bscscan.com/tx/',
  BASE: 'https://basescan.org/tx/',
  ARB:  'https://arbiscan.io/tx/',
  POLY: 'https://polygonscan.com/tx/',
};

/* ------------------------------------------------------------ address book */

const EVM_COINS = ['ETH', 'BSC', 'BASE', 'ARB', 'POLY'];

/**
 * Build the address index from env. ETH address auto-applies to every EVM chain.
 * Returns:
 *   addressSet — { normalizedAddr → canonicalAddr } for "is this one of ours?" lookups
 *   coinAddresses — { COIN → [addresses…] } passed into fetchers so they pick the right output
 */
export function buildAddressIndex(env) {
  const addresses = {
    BTC: env.CRYPTO_ADDRESS_BTC || '',
    ETH: env.CRYPTO_ADDRESS_ETH || '',
    LTC: env.CRYPTO_ADDRESS_LTC || '',
    SOL: env.CRYPTO_ADDRESS_SOL || '',
    TRX: env.CRYPTO_ADDRESS_TRX || '',
  };
  const addressSet = {};
  const coinAddresses = {};
  for (const [coin, addr] of Object.entries(addresses)) {
    if (!addr) continue;
    const norm = addr.toLowerCase().replace(/^0x/, '');
    addressSet[norm] = addr;
    if (!coinAddresses[coin]) coinAddresses[coin] = [];
    coinAddresses[coin].push(addr);
    if (coin === 'ETH') {
      for (const ev of EVM_COINS) {
        if (!coinAddresses[ev]) coinAddresses[ev] = [];
        if (!coinAddresses[ev].includes(addr)) coinAddresses[ev].push(addr);
      }
    }
  }
  return { addressSet, coinAddresses };
}

export function isOurAddress(addressSet, toAddress) {
  if (!toAddress) return false;
  const norm = toAddress.toLowerCase().replace(/^0x/, '');
  return Boolean(addressSet[norm]);
}

export function getDisplayAddress(addressSet, toAddress) {
  if (!toAddress) return 'Unknown';
  const norm = toAddress.toLowerCase().replace(/^0x/, '');
  return addressSet[norm] || toAddress;
}
