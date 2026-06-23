/**
 * universeConfig.js — Stock universe definitions for the ranking orchestrator.
 *
 * Four cap categories sourced from NSE index constituents (live fetch) with
 * comprehensive hardcoded fallbacks for when NSE API is unavailable.
 *
 * Category filters (minADV in Cr, minMcap in Cr):
 *   LARGECAP  — ADV ≥ ₹50 Cr,  spread < 0.5%,  McAP ≥ ₹20,000 Cr
 *   MIDCAP    — ADV ≥ ₹10 Cr,  spread < 1.0%,  McAP ≥ ₹5,000 Cr
 *   SMALLCAP  — ADV ≥ ₹5 Cr,   spread < 2.0%,  McAP ≥ ₹1,000 Cr
 *   MICROCAP  — ADV ≥ ₹2 Cr,   spread < 3.0%,  McAP ≥ ₹300 Cr
 *
 * Total live universe: ~750 stocks (Nifty Total Market).
 * Hardcoded fallback: ~240 curated stocks across all four caps.
 */

'use strict';

// ── Category definitions ──────────────────────────────────────────────────────

const CATEGORIES = {
  LARGECAP: {
    label:       'Large Cap',
    nseIndex:    'NIFTY 100',
    minADV:      50,     // ₹ Cr average daily value traded (20-day)
    minMcap:     20000,  // ₹ Cr market cap
    maxSpreadBps: 50,    // max bid-ask spread in basis points
    description: 'Nifty 100 — top 100 stocks by market cap',
  },
  MIDCAP: {
    label:       'Mid Cap',
    nseIndex:    'NIFTY MIDCAP 150',
    minADV:      10,
    minMcap:     5000,
    maxSpreadBps: 100,
    description: 'Nifty Midcap 150 — ranks 101–250 by market cap',
  },
  SMALLCAP: {
    label:       'Small Cap',
    nseIndex:    'NIFTY SMALLCAP 250',
    minADV:      5,
    minMcap:     1000,
    maxSpreadBps: 200,
    description: 'Nifty Smallcap 250 — ranks 251–500 by market cap',
  },
  MICROCAP: {
    label:       'Micro Cap',
    nseIndex:    'NIFTY MICROCAP 250',
    minADV:      2,
    minMcap:     300,
    maxSpreadBps: 300,
    description: 'Nifty Microcap 250 — ranks 501–750 by market cap',
  },
};

// ── Hardcoded fallback ticker lists (NSE symbols, no suffix) ─────────────────
// Used when NSE API is unavailable. Updated periodically to reflect index changes.

const FALLBACK_TICKERS = {

  LARGECAP: [
    // Nifty 50 core
    'RELIANCE','TCS','HDFCBANK','BHARTIARTL','ICICIBANK','INFOSYS','SBILIFE',
    'HINDUNILVR','ITC','LT','BAJFINANCE','HCLTECH','SBIN','MARUTI','SUNPHARMA',
    'ADANIENT','KOTAKBANK','TATAMOTORS','WIPRO','AXISBANK','NTPC','ONGC','TITAN',
    'POWERGRID','ULTRACEMCO','BAJAJFINSV','NESTLEIND','TATASTEEL','HINDALCO',
    'JSWSTEEL','COALINDIA','TECHM','GRASIM','DRREDDY','DIVISLAB','BPCL',
    'EICHERMOT','CIPLA','HDFCLIFE','BRITANNIA','INDUSINDBK','APOLLOHOSP',
    'BAJAJ-AUTO','ASIANPAINT','ADANIPORTS','HEROMOTOCO','TATACONSUM','LTIM',
    // Nifty Next 50
    'SIEMENS','ABB','HAL','BEL','BHEL','IOC','HPCL','ICICIGI','NAUKRI',
    'BAJAJHLDNG','GODREJCP','PIDILITIND','BERGEPAINT','MARICO','COLPAL','DABUR',
    'TORNTPHARM','AUROPHARMA','LALPATHLAB','METROPOLIS','FORTIS','MAXHEALTH',
    'AMBUJACEM','ACC','SHREECEM','VEDL','TATAPOWER','ADANIGREEN',
    'CHOLAFIN','MUTHOOTFIN','LICHSGFIN','RECLTD','PFC','IRFC','NHPC','SJVN',
    'IRCTC','DMART','ZOMATO','NYKAA','POLICYBZR','PAYTM'
  ],

  MIDCAP: [
    // Nifty Midcap 150 representative stocks
    'ESCORTS','MPHASIS','PERSISTENT','COFORGE','LTTS','BANKBARODA','PNB',
    'CANBK','IDFCFIRSTB','FEDERALBNK','PIIND','ALKEM','GLAND','LAURUSLABS',
    'SYNGENE','TATAELXSI','KPITTECH','INTELLECT','CYIENT','DIXON','AMBER',
    'VOLTAS','POLYCAB','KEI','VBL','JUBLFOOD','EMAMILTD','RADICO','TATACOMM',
    'CAMS','KFINTECH','CDSL','MCX','ANGELONE','ROUTE','MFSL',
    'PGHH','MANAPPURAM','CREDITACC','UJJIVANSFB','EQUITASBNK','AAVAS','REPCOHOME',
    'SOBHA','BRIGADE','PRESTIGE','PHOENIXLTD','NESCO','SAFARI','VGUARD',
    'BALAMINES','DEEPAKNI','FLUOROCHEM','CLEAN','IOLCP','JKCEMENT',
    'BIRLAMONEY','FINPIPE','NBCC','HUDCO','RVNL','IRB',
    'KALYANKJIL','SENCO','JYOTHYLAB','GOODYEAR','CASTROLIND','AEGISCHEM',
    'ATGL','MGL','IGL','GSPL','GUJGAS','PETRONET','CONCOR','TIINDIA'
  ],

  SMALLCAP: [
    // Nifty Smallcap 250 representative stocks
    'BLUESTAR','CROMPTON','HAVELLS','FINOLEX','ORIENTELEC','WESTLIFE','DEVYANI',
    'SAPPHIRE','BARBEQUE','KRBL','PFIZER','ABBOTINDIA','SANOFI','ERIS',
    'GRANULES','SOLARA','STRIDES','JBCHEPHARM','RAIN','TATACHEM','KANSAINER',
    'AKZOINDIA','NAVINFLUOR','WHIRLPOOL','SYMPHONY','VIPIND','SUPRAJIT',
    'MINDAIND','JAYASWAL','GRAPHITE','HEG','PVRINOX','INOXWIND','WAAREEENER',
    'GPPL','GMRINFRA','KIOCL','PCJEWELLER','MSTCLTD','IFCI','IRCON',
    'SJVN','PNBHOUSING','CANFINHOME','APTUS','HOMEFIRST','LICI','GICRE',
    'NIACL','STARHEALTH','BHARTIHEXA','TTML','RAILTEL','MOIL','NMDC',
    'HINDCOPPER','NATIONALUM','RATNAMANI','WELCORP','APL','JINDALSAW',
    'RAMCOCEM','NUVOCO','HEIDELBERG','ORIENTCEM','DALMIA','JKLAKSHMI',
    'SPANDANA','AROHAN','SATIN','FUSION','INDOSTAR','UGROCAP',
    'EASEMYTRIP','CARTRADE','INDIAMART','JUSTDIAL','MAPMYINDIA'
  ],

  MICROCAP: [
    // Nifty Microcap 250 representative stocks
    'SHYAMMETL','GESHIP','MSTCLTD','NBCC','INOXWIND','WAAREEENER',
    'GPPL','GMRINFRA','KIOCL','PCJEWELLER','IFCI','IRCON','SJVN',
    'PNBHOUSING','SPANDANA','AROHAN','SATIN','FUSION','INDOSTAR',
    'UGROCAP','MAPMYINDIA','NUVOCO','HEIDELBERG','ORIENTCEM',
    'JKLAKSHMI','DALMIA','RAMCOCEM','HINDCOPPER','NATIONALUM',
    'RATNAMANI','WELCORP','APL','JINDALSAW','MOIL','NMDC',
    'RAILTEL','BHARTIHEXA','TTML','LICI','GICRE','NIACL',
    'STARHEALTH','HOMEFIRST','APTUS','CANFINHOME','PNBHOUSING',
    'CHOLAHLDNG','SUNDARMFIN','M&MFIN','SHRIRAMFIN','BAJAJHLDNG',
    'MOTILALOFS','IIFLWAM','360ONE','ANAND','KARURVYSYA',
    'SOUTHBANK','DCBBANK','RBLBANK','BANDHANBNK','SURYODAY',
    'FINCARE','UTKARSH','JANA','ESAFSFB','MUTHOOTMF',
    'VARROC','MOTHERSON','SANDHAR','BHARAT','CRAFTSMAN',
    'TIINDIA','SANSERA','SHEFLER','ENDURANCE','UNITDSPR'
  ],
};

// ── Sector tags (NSE sector → standardised label) ─────────────────────────────
// Used for sector-rotation heatmap and sector-filtered scans.
const SECTOR_MAP = {
  'Financial Services':      'FINANCIALS',
  'Information Technology':  'IT',
  'Oil Gas & Consumable Fuels': 'ENERGY',
  'Fast Moving Consumer Goods': 'FMCG',
  'Automobile and Auto Components': 'AUTO',
  'Healthcare':              'PHARMA',
  'Construction':            'REALTY',
  'Metals & Mining':         'METALS',
  'Power':                   'POWER',
  'Telecommunication':       'TELECOM',
  'Consumer Durables':       'CONSUMER',
  'Capital Goods':           'CAPGOODS',
  'Chemicals':               'CHEMICALS',
  'Realty':                  'REALTY',
  'Media Entertainment & Publication': 'MEDIA',
};

// ── Helper: map NSE symbol → Yahoo Finance symbol ────────────────────────────
function toYahooSymbol(nseSymbol) {
  // Handle special cases
  const OVERRIDES = {
    'BAJAJ-AUTO':   'BAJAJ-AUTO.NS',
    'M&MFIN':       'M%26MFIN.NS',
    'L&TFH':        'L%26TFH.NS',
  };
  return OVERRIDES[nseSymbol] ?? `${nseSymbol}.NS`;
}

// ── Category detection from NSE data ─────────────────────────────────────────
// NSE API returns `yearHigh`, `yearLow`, `lastPrice`, `totalTradedVolume` etc.
// Mcap detection from index membership.
function detectCategory(symbol, indexName) {
  if (indexName.includes('100')   || indexName.includes('50'))     return 'LARGECAP';
  if (indexName.includes('MIDCAP'))                                 return 'MIDCAP';
  if (indexName.includes('SMALLCAP'))                               return 'SMALLCAP';
  if (indexName.includes('MICROCAP'))                               return 'MICROCAP';
  return 'SMALLCAP'; // safe default
}

module.exports = {
  CATEGORIES,
  FALLBACK_TICKERS,
  SECTOR_MAP,
  toYahooSymbol,
  detectCategory,
};
