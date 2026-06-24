/**
 * NSE Stock Universe — 500 stocks
 * Covers: Nifty 500 + F&O stocks + Midcap + Smallcap + Liquid penny stocks
 * Liquidity filters applied:
 *   - minAvgDailyVolume: minimum avg daily traded volume (shares)
 *   - minTradedValue:    minimum avg daily traded value (INR crores)
 *   - minMarketCap:      'Large' | 'Mid' | 'Small' | 'Micro'
 * Penny stocks: CMP typically < ₹100, included only if avg daily volume > 5,00,000 shares
 *
 * Fields per stock:
 *   sym        — Yahoo Finance symbol (e.g. RELIANCE.NS)
 *   name       — Company name
 *   sector     — Broad sector
 *   industry   — Industry group (for Industry Group Leaders scanner)
 *   cap        — 'Large' | 'Mid' | 'Small' | 'Micro'
 *   foStock    — true if F&O eligible
 *   nifty500   — true if Nifty 500 constituent
 *   penny      — true if typically < ₹100 CMP (high-volume liquid penny)
 *   minVolFilter — minimum avg daily volume required (shares); 0 = no filter
 */

const RAW_UNIVERSE = [
  // ── NIFTY 50 / LARGE CAP ────────────────────────────────────────────────────
  {sym:'RELIANCE.NS',   name:'Reliance Industries',      sector:'Energy',         industry:'Oil & Gas',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'TCS.NS',        name:'TCS',                      sector:'IT',             industry:'IT Services',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HDFCBANK.NS',   name:'HDFC Bank',                sector:'Banking',        industry:'Private Banks',          cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'INFY.NS',       name:'Infosys',                  sector:'IT',             industry:'IT Services',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ICICIBANK.NS',  name:'ICICI Bank',               sector:'Banking',        industry:'Private Banks',          cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HINDUNILVR.NS', name:'HUL',                      sector:'FMCG',           industry:'Personal Products',      cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ITC.NS',        name:'ITC',                      sector:'FMCG',           industry:'Tobacco & FMCG',         cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'SBIN.NS',       name:'SBI',                      sector:'Banking',        industry:'Public Sector Banks',    cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'BHARTIARTL.NS', name:'Bharti Airtel',            sector:'Telecom',        industry:'Telecom Services',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'BAJFINANCE.NS', name:'Bajaj Finance',            sector:'NBFC',           industry:'Consumer Finance',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'KOTAKBANK.NS',  name:'Kotak Mahindra Bank',      sector:'Banking',        industry:'Private Banks',          cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'LT.NS',         name:'Larsen & Toubro',          sector:'Infra',          industry:'Engineering & Construction',cap:'Large',foStock:true,nifty500:true,penny:false},
  {sym:'HCLTECH.NS',    name:'HCL Technologies',         sector:'IT',             industry:'IT Services',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'WIPRO.NS',      name:'Wipro',                    sector:'IT',             industry:'IT Services',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ASIANPAINT.NS', name:'Asian Paints',             sector:'Consumer',       industry:'Paints',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'AXISBANK.NS',   name:'Axis Bank',                sector:'Banking',        industry:'Private Banks',          cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'MARUTI.NS',     name:'Maruti Suzuki',            sector:'Auto',           industry:'Passenger Vehicles',     cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'SUNPHARMA.NS',  name:'Sun Pharma',               sector:'Pharma',         industry:'Pharma',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'TITAN.NS',      name:'Titan Company',            sector:'Consumer',       industry:'Jewellery',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'NTPC.NS',       name:'NTPC',                     sector:'Power',          industry:'Power Generation',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ONGC.NS',       name:'ONGC',                     sector:'Energy',         industry:'Oil & Gas',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'TATASTEEL.NS',  name:'Tata Steel',               sector:'Metals',         industry:'Steel',                  cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'BAJAJFINSV.NS', name:'Bajaj Finserv',            sector:'NBFC',           industry:'Diversified Finance',    cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'JSWSTEEL.NS',   name:'JSW Steel',                sector:'Metals',         industry:'Steel',                  cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'TECHM.NS',      name:'Tech Mahindra',            sector:'IT',             industry:'IT Services',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HEROMOTOCO.NS', name:'Hero MotoCorp',            sector:'Auto',           industry:'Two Wheelers',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'DRREDDY.NS',    name:'Dr Reddys',                sector:'Pharma',         industry:'Pharma',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'DIVISLAB.NS',   name:'Divis Labs',               sector:'Pharma',         industry:'API',                    cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'BAJAJ-AUTO.NS', name:'Bajaj Auto',               sector:'Auto',           industry:'Two Wheelers',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'CIPLA.NS',      name:'Cipla',                    sector:'Pharma',         industry:'Pharma',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ULTRACEMCO.NS', name:'UltraTech Cement',         sector:'Cement',         industry:'Cement',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'POWERGRID.NS',  name:'Power Grid Corp',          sector:'Power',          industry:'Power Transmission',     cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'NESTLEIND.NS',  name:'Nestle India',             sector:'FMCG',           industry:'Food Products',          cap:'Large',foStock:false,nifty500:true,penny:false},
  {sym:'GRASIM.NS',     name:'Grasim Industries',        sector:'Conglomerate',   industry:'Diversified',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HAL.NS',        name:'HAL',                      sector:'Defence',        industry:'Aerospace & Defence',    cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HAVELLS.NS',    name:'Havells India',            sector:'Electrical',     industry:'Electrical Equipment',   cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HINDALCO.NS',   name:'Hindalco Industries',      sector:'Metals',         industry:'Aluminium',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'INDIGO.NS',     name:'IndiGo',                   sector:'Aviation',       industry:'Airlines',               cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'IRFC.NS',       name:'IRFC',                     sector:'NBFC',           industry:'Govt Finance',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'M&M.NS',        name:'Mahindra & Mahindra',      sector:'Auto',           industry:'Utility Vehicles',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'BPCL.NS',       name:'BPCL',                     sector:'Energy',         industry:'Oil Refining',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'DABUR.NS',      name:'Dabur India',              sector:'FMCG',           industry:'Personal Products',      cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'DLF.NS',        name:'DLF',                      sector:'Realty',         industry:'Real Estate',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'GAIL.NS',       name:'GAIL',                     sector:'Energy',         industry:'Gas Distribution',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'PFC.NS',        name:'Power Finance Corp',       sector:'NBFC',           industry:'Govt Finance',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'SHREECEM.NS',   name:'Shree Cement',             sector:'Cement',         industry:'Cement',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'SIEMENS.NS',    name:'Siemens India',            sector:'Capital Goods',  industry:'Industrial Equipment',   cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'TATAMOTORS.NS', name:'Tata Motors',              sector:'Auto',           industry:'Commercial Vehicles',    cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'TATACONSUM.NS', name:'Tata Consumer Products',   sector:'FMCG',           industry:'Food & Beverages',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'UPL.NS',        name:'UPL',                      sector:'Agrochem',       industry:'Agrochemicals',          cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'VEDL.NS',       name:'Vedanta',                  sector:'Metals',         industry:'Diversified Metals',     cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ZOMATO.NS',     name:'Zomato',                   sector:'Internet',       industry:'Food Tech',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ZYDUSLIFE.NS',  name:'Zydus Lifesciences',       sector:'Pharma',         industry:'Pharma',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ADANIENT.NS',   name:'Adani Enterprises',        sector:'Conglomerate',   industry:'Diversified',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ADANIPORTS.NS', name:'Adani Ports',              sector:'Logistics',      industry:'Ports',                  cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'EICHERMOT.NS',  name:'Eicher Motors',            sector:'Auto',           industry:'Two Wheelers',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'BOSCHLTD.NS',   name:'Bosch',                    sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'COLPAL.NS',     name:'Colgate-Palmolive',        sector:'FMCG',           industry:'Personal Products',      cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'HINDPETRO.NS',  name:'HPCL',                     sector:'Energy',         industry:'Oil Refining',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'PIDILITIND.NS', name:'Pidilite Industries',      sector:'Chemicals',      industry:'Adhesives',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'AMBUJACEM.NS',  name:'Ambuja Cements',           sector:'Cement',         industry:'Cement',                 cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'RECLTD.NS',     name:'REC',                      sector:'NBFC',           industry:'Govt Finance',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'SBICARD.NS',    name:'SBI Cards',                sector:'NBFC',           industry:'Credit Cards',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'SBILIFE.NS',    name:'SBI Life Insurance',       sector:'Insurance',      industry:'Life Insurance',         cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ICICIPRULI.NS', name:'ICICI Prudential Life',    sector:'Insurance',      industry:'Life Insurance',         cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ICICIGI.NS',    name:'ICICI Lombard',            sector:'Insurance',      industry:'General Insurance',      cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'PETRONET.NS',   name:'Petronet LNG',             sector:'Energy',         industry:'LNG',                    cap:'Large',foStock:true, nifty500:true,penny:false},
  // ── NIFTY MIDCAP 150 ────────────────────────────────────────────────────────
  {sym:'DIXON.NS',      name:'Dixon Technologies',       sector:'Electronics',    industry:'Contract Manufacturing', cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'POLYCAB.NS',    name:'Polycab India',            sector:'Cables',         industry:'Cables & Wires',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TATAELXSI.NS',  name:'Tata Elxsi',               sector:'IT',             industry:'Design Services',        cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PERSISTENT.NS', name:'Persistent Systems',       sector:'IT',             industry:'IT Services',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'COFORGE.NS',    name:'Coforge',                  sector:'IT',             industry:'IT Services',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'APOLLOHOSP.NS', name:'Apollo Hospitals',         sector:'Healthcare',     industry:'Hospitals',              cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ASTRAL.NS',     name:'Astral',                   sector:'Pipes',          industry:'Plastic Pipes',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'AUROPHARMA.NS', name:'Aurobindo Pharma',         sector:'Pharma',         industry:'Generics',               cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CAMS.NS',       name:'CAMS',                     sector:'Fintech',        industry:'Financial Services',     cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'GRINDWELL.NS',  name:'Grindwell Norton',         sector:'Industrials',    industry:'Abrasives',              cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'LTIM.NS',       name:'LTIMindtree',              sector:'IT',             industry:'IT Services',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MPHASIS.NS',    name:'Mphasis',                  sector:'IT',             industry:'IT Services',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CGPOWER.NS',    name:'CG Power',                 sector:'Electrical',     industry:'Electrical Equipment',   cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PIIND.NS',      name:'PI Industries',            sector:'Agrochem',       industry:'Agrochemicals',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'SRF.NS',        name:'SRF',                      sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CHOLAFIN.NS',   name:'Chola Finance',            sector:'NBFC',           industry:'Vehicle Finance',        cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CUMMINSIND.NS', name:'Cummins India',            sector:'Industrials',    industry:'Engines',                cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'DEEPAKNTR.NS',  name:'Deepak Nitrite',           sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IRCTC.NS',      name:'IRCTC',                    sector:'Travel',         industry:'Tourism',                cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'LUPIN.NS',      name:'Lupin',                    sector:'Pharma',         industry:'Generics',               cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MARICO.NS',     name:'Marico',                   sector:'FMCG',           industry:'Personal Products',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MAXHEALTH.NS',  name:'Max Healthcare',           sector:'Healthcare',     industry:'Hospitals',              cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MOTHERSON.NS',  name:'Motherson Sumi',           sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MUTHOOTFIN.NS', name:'Muthoot Finance',          sector:'NBFC',           industry:'Gold Finance',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'NAUKRI.NS',     name:'Info Edge',                sector:'Internet',       industry:'Job Portal',             cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'OBEROIRLTY.NS', name:'Oberoi Realty',            sector:'Realty',         industry:'Real Estate',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PAGEIND.NS',    name:'Page Industries',          sector:'Consumer',       industry:'Innerwear',              cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PHOENIXLTD.NS', name:'Phoenix Mills',            sector:'Realty',         industry:'Retail Malls',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PRESTIGE.NS',   name:'Prestige Estates',         sector:'Realty',         industry:'Real Estate',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'KEI.NS',        name:'KEI Industries',           sector:'Cables',         industry:'Cables & Wires',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'KPITTECH.NS',   name:'KPIT Technologies',        sector:'IT',             industry:'Automotive Tech',        cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'APOLLOTYRE.NS', name:'Apollo Tyres',             sector:'Auto Ancillary', industry:'Tyres',                  cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ASHOKLEY.NS',   name:'Ashok Leyland',            sector:'Auto',           industry:'Commercial Vehicles',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'BIOCON.NS',     name:'Biocon',                   sector:'Pharma',         industry:'Biologics',              cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'BHEL.NS',       name:'BHEL',                     sector:'Capital Goods',  industry:'Heavy Engineering',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CANBK.NS',      name:'Canara Bank',              sector:'Banking',        industry:'Public Sector Banks',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CONCOR.NS',     name:'Container Corp',           sector:'Logistics',      industry:'Rail Logistics',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'FEDERALBNK.NS', name:'Federal Bank',             sector:'Banking',        industry:'Private Banks',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'GODREJPROP.NS', name:'Godrej Properties',        sector:'Realty',         industry:'Real Estate',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IDFCFIRSTB.NS', name:'IDFC First Bank',          sector:'Banking',        industry:'Private Banks',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'INDHOTEL.NS',   name:'Indian Hotels',            sector:'Hotels',         industry:'Hotels & Resorts',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'JUBLFOOD.NS',   name:'Jubilant FoodWorks',       sector:'QSR',            industry:'Restaurants',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MANAPPURAM.NS', name:'Manappuram Finance',       sector:'NBFC',           industry:'Gold Finance',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'NYKAA.NS',      name:'Nykaa',                    sector:'Retail',         industry:'Beauty Retail',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PNB.NS',        name:'Punjab National Bank',     sector:'Banking',        industry:'Public Sector Banks',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'SAIL.NS',       name:'SAIL',                     sector:'Metals',         industry:'Steel',                  cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TATACOMM.NS',   name:'Tata Communications',      sector:'Telecom',        industry:'Data Services',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TATAPOWER.NS',  name:'Tata Power',               sector:'Power',          industry:'Integrated Power',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TORNTPHARM.NS', name:'Torrent Pharma',           sector:'Pharma',         industry:'Pharma',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TRENT.NS',      name:'Trent',                    sector:'Retail',         industry:'Fashion Retail',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ABCAPITAL.NS',  name:'Aditya Birla Capital',     sector:'NBFC',           industry:'Diversified Finance',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ALKEM.NS',      name:'Alkem Laboratories',       sector:'Pharma',         industry:'Pharma',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'BALKRISIND.NS', name:'Balkrishna Industries',    sector:'Auto Ancillary', industry:'Tyres',                  cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'BRIGADE.NS',    name:'Brigade Enterprises',      sector:'Realty',         industry:'Real Estate',            cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'CROMPTON.NS',   name:'Crompton Greaves',         sector:'Electrical',     industry:'Consumer Electrical',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'DALBHARAT.NS',  name:'Dalmia Bharat',            sector:'Cement',         industry:'Cement',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ELGIEQUIP.NS',  name:'Elgi Equipments',          sector:'Industrials',    industry:'Compressors',            cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'JKCEMENT.NS',   name:'JK Cement',                sector:'Cement',         industry:'Cement',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'KAJARIACER.NS', name:'Kajaria Ceramics',         sector:'Consumer',       industry:'Ceramics',               cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'LICHSGFIN.NS',  name:'LIC Housing Finance',      sector:'Housing Finance', industry:'Mortgage Finance',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'LINDEINDIA.NS', name:'Linde India',              sector:'Chemicals',      industry:'Industrial Gases',       cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'MCX.NS',        name:'MCX',                      sector:'Fintech',        industry:'Commodity Exchange',     cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'METROPOLIS.NS', name:'Metropolis Healthcare',    sector:'Healthcare',     industry:'Diagnostics',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'NAVINFLUOR.NS', name:'Navin Fluorine',           sector:'Chemicals',      industry:'Fluorochemicals',        cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'OFSS.NS',       name:'Oracle Financial',         sector:'IT',             industry:'Banking Software',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TORNTPOWER.NS', name:'Torrent Power',            sector:'Power',          industry:'Integrated Power',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'UBL.NS',        name:'United Breweries',         sector:'Consumer',       industry:'Beverages',              cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'VOLTAS.NS',     name:'Voltas',                   sector:'Consumer',       industry:'Air Conditioning',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'M&MFIN.NS',     name:'M&M Financial',            sector:'NBFC',           industry:'Vehicle Finance',        cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'SYNGENE.NS',    name:'Syngene International',    sector:'Pharma',         industry:'CRO',                    cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'JSWENERGY.NS',  name:'JSW Energy',               sector:'Power',          industry:'Power Generation',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'KFINTECH.NS',   name:'KFin Technologies',        sector:'Fintech',        industry:'Financial Services',     cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'ENDURANCE.NS',  name:'Endurance Technologies',   sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'ESCORTS.NS',    name:'Escorts Kubota',           sector:'Auto',           industry:'Farm Equipment',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'EXIDEIND.NS',   name:'Exide Industries',         sector:'Auto Ancillary', industry:'Batteries',              cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'GSPL.NS',       name:'Gujarat State Petronet',   sector:'Energy',         industry:'Gas Pipelines',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IGL.NS',        name:'Indraprastha Gas',         sector:'Energy',         industry:'Gas Distribution',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'INDUSTOWER.NS', name:'Indus Towers',             sector:'Telecom',        industry:'Telecom Infrastructure', cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'NMDC.NS',       name:'NMDC',                     sector:'Metals',         industry:'Iron Ore',               cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'JINDALSTEL.NS', name:'Jindal Steel',             sector:'Metals',         industry:'Steel',                  cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'TATACHEM.NS',   name:'Tata Chemicals',           sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ABFRL.NS',      name:'Aditya Birla Fashion',     sector:'Retail',         industry:'Fashion Retail',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ACC.NS',        name:'ACC',                      sector:'Cement',         industry:'Cement',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ATUL.NS',       name:'Atul',                     sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'BANDHANBNK.NS', name:'Bandhan Bank',             sector:'Banking',        industry:'Private Banks',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'BERGEPAINT.NS', name:'Berger Paints',            sector:'Consumer',       industry:'Paints',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'COROMANDEL.NS', name:'Coromandel International', sector:'Agrochem',       industry:'Fertilisers',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'EMAMILTD.NS',   name:'Emami',                    sector:'FMCG',           industry:'Personal Products',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'GUJGASLTD.NS',  name:'Gujarat Gas',              sector:'Energy',         industry:'Gas Distribution',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IPCALAB.NS',    name:'Ipca Laboratories',        sector:'Pharma',         industry:'Pharma',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IRB.NS',        name:'IRB Infrastructure',       sector:'Infra',          industry:'Road Infrastructure',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'LALPATHLAB.NS', name:'Dr Lal Pathlabs',          sector:'Healthcare',     industry:'Diagnostics',            cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'LAURUSLABS.NS', name:'Laurus Labs',              sector:'Pharma',         industry:'API',                    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MGL.NS',        name:'Mahanagar Gas',            sector:'Energy',         industry:'Gas Distribution',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MFSL.NS',       name:'Max Financial Services',   sector:'Insurance',      industry:'Life Insurance',         cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'NBCC.NS',       name:'NBCC India',               sector:'Infra',          industry:'Construction',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PIRAMALENT.NS', name:'Piramal Enterprises',      sector:'NBFC',           industry:'Diversified Finance',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'RBLBANK.NS',    name:'RBL Bank',                 sector:'Banking',        industry:'Private Banks',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'SUNDARMFIN.NS', name:'Sundaram Finance',         sector:'NBFC',           industry:'Vehicle Finance',        cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'SUNTV.NS',      name:'Sun TV Network',           sector:'Media',          industry:'Broadcasting',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ZEEL.NS',       name:'Zee Entertainment',        sector:'Media',          industry:'Broadcasting',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'HONAUT.NS',     name:'Honeywell Automation',     sector:'Capital Goods',  industry:'Industrial Automation',  cap:'Large',foStock:false,nifty500:true,penny:false},
  {sym:'TTKPRESTIG.NS', name:'TTK Prestige',             sector:'Consumer',       industry:'Kitchenware',            cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'WHIRLPOOL.NS',  name:'Whirlpool India',          sector:'Consumer',       industry:'Consumer Durables',      cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'POLYMED.NS',    name:'Poly Medicure',            sector:'Healthcare',     industry:'Medical Devices',        cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'PGHH.NS',       name:'P&G Hygiene',              sector:'FMCG',           industry:'Personal Products',      cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'NATCOPHARM.NS', name:'Natco Pharma',             sector:'Pharma',         industry:'Generics',               cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'JUBILANT.NS',   name:'Jubilant Ingrevia',        sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Mid', foStock:false,nifty500:true,penny:false},
  // ── NIFTY SMALLCAP 250 ──────────────────────────────────────────────────────
  {sym:'SUZLON.NS',     name:'Suzlon Energy',            sector:'Energy',         industry:'Wind Energy',            cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'APLAPOLLO.NS',  name:'APL Apollo Tubes',         sector:'Metals',         industry:'Steel Tubes',            cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'CLEANSCIENCE.NS',name:'Clean Science',           sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'FINEORG.NS',    name:'Fine Organics',            sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SOLARINDS.NS',  name:'Solar Industries',         sector:'Chemicals',      industry:'Explosives',             cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'HEG.NS',        name:'HEG',                      sector:'Industrials',    industry:'Graphite Electrodes',    cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'LATENTVIEW.NS', name:'Latent View Analytics',    sector:'IT',             industry:'Data Analytics',         cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'MASTEK.NS',     name:'Mastek',                   sector:'IT',             industry:'IT Services',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'CAMPUS.NS',     name:'Campus Activewear',        sector:'Consumer',       industry:'Footwear',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'DELHIVERY.NS',  name:'Delhivery',                sector:'Logistics',      industry:'Courier & Delivery',     cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'ETHOSLTD.NS',   name:'Ethos',                    sector:'Consumer',       industry:'Luxury Watches',         cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'GLAND.NS',      name:'Gland Pharma',             sector:'Pharma',         industry:'Injectables',            cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'IOLCP.NS',      name:'IOL Chemicals',            sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'JKPAPER.NS',    name:'JK Paper',                 sector:'Paper',          industry:'Paper Products',         cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'KRBL.NS',       name:'KRBL',                     sector:'FMCG',           industry:'Packaged Foods',         cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'MEDPLUS.NS',    name:'Medplus Health',           sector:'Healthcare',     industry:'Pharmacy Retail',        cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'MOLDTKPAC.NS',  name:'Mold-Tek Packaging',       sector:'Packaging',      industry:'Packaging',              cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'NAZARA.NS',     name:'Nazara Technologies',      sector:'Gaming',         industry:'Mobile Gaming',          cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'RAYMOND.NS',    name:'Raymond',                  sector:'Consumer',       industry:'Textiles',               cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'REDINGTON.NS',  name:'Redington',                sector:'IT',             industry:'IT Distribution',        cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'ROUTE.NS',      name:'Route Mobile',             sector:'IT',             industry:'Cloud Communications',   cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SAPPHIRE.NS',   name:'Sapphire Foods',           sector:'QSR',            industry:'Restaurants',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SHYAMMETL.NS',  name:'Shyam Metalics',           sector:'Metals',         industry:'Steel',                  cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SPANDANA.NS',   name:'Spandana Sphoorty',        sector:'NBFC',           industry:'Microfinance',           cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'STLTECH.NS',    name:'Sterlite Technologies',    sector:'IT',             industry:'Optical Fibre',          cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'TEAMLEASE.NS',  name:'TeamLease Services',       sector:'HR',             industry:'Staffing',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'THYROCARE.NS',  name:'Thyrocare',                sector:'Healthcare',     industry:'Diagnostics',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'UJJIVANSFB.NS', name:'Ujjivan SFB',              sector:'Banking',        industry:'Small Finance Banks',    cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'UTIAMC.NS',     name:'UTI AMC',                  sector:'Fintech',        industry:'Asset Management',       cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'VAIBHAVGBL.NS', name:'Vaibhav Global',           sector:'Consumer',       industry:'Jewellery Retail',       cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'VMART.NS',      name:'V-Mart Retail',            sector:'Retail',         industry:'Value Retail',           cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'WELCORP.NS',    name:'Welspun Corp',             sector:'Metals',         industry:'Pipes',                  cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'ZENTEC.NS',     name:'Zen Technologies',         sector:'Defence',        industry:'Defence Training',       cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'NLCINDIA.NS',   name:'NLC India',                sector:'Power',          industry:'Power & Lignite',        cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'GLOBUSSPR.NS',  name:'Globus Spirits',           sector:'Consumer',       industry:'Spirits',                cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'MAHINDCIE.NS',  name:'Mahindra CIE Auto',        sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'NETWORK18.NS',  name:'Network18 Media',          sector:'Media',          industry:'Broadcasting',           cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'VSTIND.NS',     name:'VST Industries',           sector:'FMCG',           industry:'Tobacco',                cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'UNIPARTS.NS',   name:'Uniparts India',           sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'SUNDRMBFAST.NS',name:'Sundram Fasteners',        sector:'Auto Ancillary', industry:'Fasteners',              cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'TATAINVEST.NS', name:'Tata Investment',          sector:'NBFC',           industry:'Investment Holding',     cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'PNBHOUSING.NS', name:'PNB Housing Finance',      sector:'Housing Finance', industry:'Mortgage Finance',      cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'AAVAS.NS',      name:'Aavas Financiers',         sector:'Housing Finance', industry:'Mortgage Finance',      cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'HOMEFIRST.NS',  name:'Home First Finance',       sector:'Housing Finance', industry:'Mortgage Finance',      cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'KANSAINER.NS',  name:'Kansai Nerolac',           sector:'Consumer',       industry:'Paints',                 cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SCHNEIDER.NS',  name:'Schneider Electric',       sector:'Electrical',     industry:'Electrical Equipment',   cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'GESHIP.NS',     name:'The Great Eastern Shipping',sector:'Logistics',     industry:'Shipping',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SCI.NS',        name:'Shipping Corp of India',   sector:'Logistics',      industry:'Shipping',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'MCDOWELL-N.NS', name:'United Spirits',           sector:'Consumer',       industry:'Spirits',                cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'JYOTHYLAB.NS',  name:'Jyothy Labs',              sector:'FMCG',           industry:'Personal Products',      cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'GPPL.NS',       name:'Gujarat Pipavav Port',     sector:'Logistics',      industry:'Ports',                  cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'VSTTILLERS.NS', name:'VST Tillers Tractors',     sector:'Auto',           industry:'Farm Equipment',         cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'SWSOLAR.NS',    name:'Sterling & Wilson Solar',  sector:'Energy',         industry:'Solar EPC',              cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'GOCOLORS.NS',   name:'Go Fashion',               sector:'Retail',         industry:'Fashion Retail',         cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'INOXWIND.NS',   name:'Inox Wind',                sector:'Energy',         industry:'Wind Energy',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'RPOWER.NS',     name:'Reliance Power',           sector:'Power',          industry:'Power Generation',       cap:'Micro',foStock:false,nifty500:false,penny:true},
  {sym:'YESBANK.NS',    name:'Yes Bank',                 sector:'Banking',        industry:'Private Banks',          cap:'Small',foStock:true, nifty500:true,penny:true},
  {sym:'IREDA.NS',      name:'IREDA',                    sector:'NBFC',           industry:'Govt Finance',           cap:'Small',foStock:true, nifty500:false,penny:false},
  {sym:'RVNL.NS',       name:'Rail Vikas Nigam',         sector:'Infra',          industry:'Railways',               cap:'Small',foStock:true, nifty500:false,penny:false},
  {sym:'NHPC.NS',       name:'NHPC',                     sector:'Power',          industry:'Hydropower',             cap:'Small',foStock:true, nifty500:true,penny:true},
  {sym:'SJVN.NS',       name:'SJVN',                     sector:'Power',          industry:'Hydropower',             cap:'Small',foStock:true, nifty500:true,penny:true},
  {sym:'MRPL.NS',       name:'MRPL',                     sector:'Energy',         industry:'Oil Refining',           cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SOBHA.NS',      name:'Sobha',                    sector:'Realty',         industry:'Real Estate',            cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'MAHLIFE.NS',    name:'Mahindra Lifespace',       sector:'Realty',         industry:'Real Estate',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'KOLTEPATIL.NS', name:'Kolte-Patil Developers',  sector:'Realty',         industry:'Real Estate',            cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'ANANTRAJ.NS',   name:'Anant Raj',                sector:'Realty',         industry:'Real Estate',            cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'NCC.NS',        name:'NCC',                      sector:'Infra',          industry:'Engineering & Construction',cap:'Small',foStock:true,nifty500:true,penny:false},
  {sym:'KNR.NS',        name:'KNR Constructions',        sector:'Infra',          industry:'Road Infrastructure',    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'GPIL.NS',       name:'Godawari Power & Ispat',   sector:'Metals',         industry:'Steel',                  cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'RATNAMANI.NS',  name:'Ratnamani Metals',         sector:'Metals',         industry:'Pipes',                  cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SARDAEN.NS',    name:'Sarda Energy & Minerals',  sector:'Metals',         industry:'Steel',                  cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'TINPLATE.NS',   name:'Tata Tinplate',            sector:'Metals',         industry:'Tin Products',           cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'MAHSEAMLES.NS', name:'Maharashtra Seamless',     sector:'Metals',         industry:'Pipes',                  cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'GRAPHITE.NS',   name:'Graphite India',           sector:'Industrials',    industry:'Graphite Electrodes',    cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'THERMAX.NS',    name:'Thermax',                  sector:'Capital Goods',  industry:'Industrial Equipment',   cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'BHELDEL.NS',    name:'BHEL',                     sector:'Capital Goods',  industry:'Heavy Engineering',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'AIAENG.NS',     name:'AIA Engineering',          sector:'Industrials',    industry:'Engineering',            cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'BEML.NS',       name:'BEML',                     sector:'Capital Goods',  industry:'Defence & Rail',         cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'TIINDIA.NS',    name:'Tube Investments',         sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'SCHAEFFLER.NS', name:'Schaeffler India',         sector:'Auto Ancillary', industry:'Bearings',               cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'SKFINDIA.NS',   name:'SKF India',                sector:'Auto Ancillary', industry:'Bearings',               cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'FAGBEARINGS.NS',name:'Schaeffler India (FAG)',   sector:'Auto Ancillary', industry:'Bearings',               cap:'Mid', foStock:false,nifty500:false,penny:false},
  {sym:'MMTC.NS',       name:'MMTC',                     sector:'Conglomerate',   industry:'Trading',                cap:'Small',foStock:false,nifty500:false,penny:true},
  {sym:'MOIL.NS',       name:'MOIL',                     sector:'Metals',         industry:'Manganese',              cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'NALCO.NS',      name:'NALCO',                    sector:'Metals',         industry:'Aluminium',              cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'HINDZINC.NS',   name:'Hindustan Zinc',           sector:'Metals',         industry:'Zinc & Silver',          cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'COALINDIA.NS',  name:'Coal India',               sector:'Energy',         industry:'Coal Mining',            cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'MTNL.NS',       name:'MTNL',                     sector:'Telecom',        industry:'Telecom Services',       cap:'Micro',foStock:false,nifty500:false,penny:true},
  {sym:'BBTC.NS',       name:'Bombay Burmah Trading',   sector:'Conglomerate',   industry:'Diversified',            cap:'Small',foStock:false,nifty500:false,penny:false},
  // ── HIGH-LIQUIDITY PENNY STOCKS (avg vol > 5L shares, CMP < ₹100) ──────────
  // Minimum liquidity: minVolFilter >= 500000 shares avg daily
  {sym:'VODAFONE.NS',   name:'Vodafone Idea',            sector:'Telecom',        industry:'Telecom Services',       cap:'Micro',foStock:true, nifty500:false,penny:true,  minVolFilter:5000000},
  {sym:'GMRINFRA.NS',   name:'GMR Airports',             sector:'Infra',          industry:'Airports',               cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'JPPOWER.NS',    name:'Jaiprakash Power',         sector:'Power',          industry:'Power Generation',       cap:'Micro',foStock:false,nifty500:false,penny:true,  minVolFilter:2000000},
  {sym:'JPASSOCIAT.NS', name:'Jaiprakash Associates',   sector:'Infra',          industry:'Engineering & Construction',cap:'Micro',foStock:false,nifty500:false,penny:true,minVolFilter:1000000},
  {sym:'ADANIGREEN.NS', name:'Adani Green Energy',       sector:'Energy',         industry:'Solar & Wind Energy',    cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'ADANITRANS.NS', name:'Adani Transmission',       sector:'Power',          industry:'Power Transmission',     cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'PAYTM.NS',      name:'One97 Communications',     sector:'Fintech',        industry:'Payment Services',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  // ── ADDITIONAL F&O STOCKS ───────────────────────────────────────────────────
  {sym:'AUBANK.NS',     name:'AU Small Finance Bank',    sector:'Banking',        industry:'Small Finance Banks',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'BATAINDIA.NS',  name:'Bata India',               sector:'Consumer',       industry:'Footwear',               cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CANFINHOME.NS', name:'Can Fin Homes',            sector:'Housing Finance', industry:'Mortgage Finance',      cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'CDSL.NS',       name:'CDSL',                     sector:'Fintech',        industry:'Depository Services',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'CHAMBLFERT.NS', name:'Chambal Fertilisers',      sector:'Agrochem',       industry:'Fertilisers',            cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'CESC.NS',       name:'CESC',                     sector:'Power',          industry:'Integrated Power',       cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'COCHINSHIP.NS', name:'Cochin Shipyard',          sector:'Capital Goods',  industry:'Shipbuilding',           cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'DELTACORP.NS',  name:'Delta Corp',               sector:'Consumer',       industry:'Gaming & Hospitality',   cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'EIDPARRY.NS',   name:'EID Parry',                sector:'Agrochem',       industry:'Sugar',                  cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'GLENMARK.NS',   name:'Glenmark Pharma',          sector:'Pharma',         industry:'Generics',               cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'GMMPFAUDLR.NS', name:'GMM Pfaudler',             sector:'Industrials',    industry:'Glass Lined Equipment',  cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'GRANULES.NS',   name:'Granules India',           sector:'Pharma',         industry:'API',                    cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'HINDCOPPER.NS', name:'Hindustan Copper',         sector:'Metals',         industry:'Copper',                 cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'IDBI.NS',       name:'IDBI Bank',                sector:'Banking',        industry:'Public Sector Banks',    cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IDEA.NS',       name:'Vodafone Idea',            sector:'Telecom',        industry:'Telecom Services',       cap:'Micro',foStock:true, nifty500:true,penny:true,  minVolFilter:5000000},
  {sym:'IFBIND.NS',     name:'IFB Industries',           sector:'Consumer',       industry:'Consumer Durables',      cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'INDIACEM.NS',   name:'India Cements',            sector:'Cement',         industry:'Cement',                 cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'INGERRAND.NS',  name:'Ingersoll-Rand India',     sector:'Industrials',    industry:'Compressors',            cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'JKIL.NS',       name:'J Kumar Infraprojects',    sector:'Infra',          industry:'Engineering & Construction',cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'NIACL.NS',      name:'New India Assurance',      sector:'Insurance',      industry:'General Insurance',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'PCBL.NS',       name:'PCBL',                     sector:'Chemicals',      industry:'Carbon Black',           cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'PVRINOX.NS',    name:'PVR Inox',                 sector:'Consumer',       industry:'Entertainment',          cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'RALLIS.NS',     name:'Rallis India',             sector:'Agrochem',       industry:'Agrochemicals',          cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'RAMCOCEM.NS',   name:'Ramco Cements',            sector:'Cement',         industry:'Cement',                 cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'STAR.NS',       name:'Strides Pharma',           sector:'Pharma',         industry:'Generics',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'TATAMETALI.NS', name:'Tata Metaliks',            sector:'Metals',         industry:'Cast Iron',              cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'TFCILTD.NS',    name:'Tourism Finance Corp',     sector:'NBFC',           industry:'Tourism Finance',        cap:'Micro',foStock:false,nifty500:false,penny:true,  minVolFilter:500000},
  {sym:'TV18BRDCST.NS', name:'TV18 Broadcast',           sector:'Media',          industry:'Broadcasting',           cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'TVSMOTOR.NS',   name:'TVS Motor Company',        sector:'Auto',           industry:'Two Wheelers',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'UJJIVAN.NS',    name:'Ujjivan Financial Services',sector:'NBFC',          industry:'Microfinance',           cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'VBL.NS',        name:'Varun Beverages',          sector:'Consumer',       industry:'Beverages',              cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'VGUARD.NS',     name:'V-Guard Industries',       sector:'Electrical',     industry:'Consumer Electrical',    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'WENDT.NS',      name:'Wendt India',              sector:'Industrials',    industry:'Abrasives',              cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'ZENSARTECH.NS', name:'Zensar Technologies',      sector:'IT',             industry:'IT Services',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'ABSLBANETF.NS', name:'Aditya Birla SL Nifty Bank',sector:'Fintech',      industry:'ETF',                    cap:'Mid', foStock:false,nifty500:false,penny:false},
  {sym:'MAZDOCK.NS',    name:'Mazagon Dock',             sector:'Capital Goods',  industry:'Shipbuilding',           cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'GARFIBRES.NS',  name:'Garware Technical Fibres', sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'ASTERDM.NS',    name:'Aster DM Healthcare',      sector:'Healthcare',     industry:'Hospitals',              cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'HLEGLAS.NS',    name:'HLE Glascoat',             sector:'Industrials',    industry:'Glass Lined Equipment',  cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'KRSNAA.NS',     name:'Krsnaa Diagnostics',       sector:'Healthcare',     industry:'Diagnostics',            cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'MEDANTA.NS',    name:'Global Health (Medanta)',   sector:'Healthcare',     industry:'Hospitals',              cap:'Mid', foStock:false,nifty500:true,penny:false},
  {sym:'BIKAJI.NS',     name:'Bikaji Foods',             sector:'FMCG',           industry:'Snack Foods',            cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'DMART.NS',      name:'Avenue Supermarts (DMart)', sector:'Retail',        industry:'Supermarkets',           cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'NUVAMA.NS',     name:'Nuvama Wealth Management', sector:'Fintech',        industry:'Wealth Management',      cap:'Mid', foStock:false,nifty500:false,penny:false},
  {sym:'360ONE.NS',     name:'360 ONE WAM',              sector:'Fintech',        industry:'Wealth Management',      cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'HDFCAMC.NS',    name:'HDFC AMC',                 sector:'Fintech',        industry:'Asset Management',       cap:'Large',foStock:true, nifty500:true,penny:false},
  {sym:'NIPPONLIFE.NS', name:'Nippon India Mutual Fund',  sector:'Fintech',       industry:'Asset Management',       cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'ANGELONE.NS',   name:'Angel One',                sector:'Fintech',        industry:'Broking',                cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'MOTILALOFS.NS', name:'Motilal Oswal Financial',  sector:'Fintech',        industry:'Broking',                cap:'Mid', foStock:true, nifty500:true,penny:false},
  {sym:'IIFL.NS',       name:'IIFL Finance',             sector:'NBFC',           industry:'Consumer Finance',       cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'NUVOCO.NS',     name:'Nuvoco Vistas',            sector:'Cement',         industry:'Cement',                 cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'CRAFTSMAN.NS',  name:'Craftsman Automation',     sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'ELECTCAST.NS',  name:'Electrosteel Castings',    sector:'Metals',         industry:'Cast Iron Pipes',        cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'RHFL.NS',       name:'Repco Home Finance',       sector:'Housing Finance', industry:'Mortgage Finance',      cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'JINDALSAW.NS',  name:'Jindal Saw',               sector:'Metals',         industry:'Pipes',                  cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'JAMNAAUTO.NS',  name:'Jamna Auto Industries',    sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'PRICOLLTD.NS',  name:'Pricol',                   sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'WABAG.NS',      name:'VA Tech Wabag',            sector:'Infra',          industry:'Water Treatment',        cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'TEXRAIL.NS',    name:'Texmaco Rail & Engineering',sector:'Capital Goods', industry:'Railway Equipment',      cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'IRCON.NS',      name:'Ircon International',      sector:'Infra',          industry:'Railways',               cap:'Small',foStock:true, nifty500:true,penny:false},
  {sym:'RAILVIKAS.NS',  name:'Rail Vikas Nigam',         sector:'Infra',          industry:'Railways',               cap:'Small',foStock:true, nifty500:false,penny:false},
  {sym:'INDIGOPNTS.NS', name:'Indigo Paints',            sector:'Consumer',       industry:'Paints',                 cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'FIVESTAR.NS',   name:'Five-Star Business Finance',sector:'NBFC',          industry:'MSME Finance',           cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'CREDITACC.NS',  name:'Creditas Solutions',       sector:'NBFC',           industry:'Microfinance',           cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'CIEINDIA.NS',   name:'CIE Automotive India',     sector:'Auto Ancillary', industry:'Auto Parts',             cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'TATVA.NS',      name:'Tatva Chintan Pharma',     sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'SUDARSCHEM.NS', name:'Sudarshan Chemical',       sector:'Chemicals',      industry:'Pigments',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'VINATIORGA.NS', name:'Vinati Organics',          sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'ROSSARI.NS',    name:'Rossari Biotech',          sector:'Chemicals',      industry:'Specialty Chemicals',    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'CHEMPLASTS.NS', name:'Chemplast Sanmar',         sector:'Chemicals',      industry:'PVC',                    cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'SOLARA.NS',     name:'Solara Active Pharma',     sector:'Pharma',         industry:'API',                    cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'STRIDES.NS',    name:'Strides Pharma Science',   sector:'Pharma',         industry:'Generics',               cap:'Small',foStock:false,nifty500:true,penny:false},
  {sym:'DISHTV.NS',     name:'Dish TV India',            sector:'Media',          industry:'DTH Services',           cap:'Micro',foStock:false,nifty500:false,penny:true,  minVolFilter:1000000},
  {sym:'HATHWAY.NS',    name:'Hathway Cable & Datacom',  sector:'Media',          industry:'Cable & Broadband',      cap:'Micro',foStock:false,nifty500:false,penny:true,  minVolFilter:500000},
  {sym:'EROSMEDIA.NS',  name:'Eros STX Global',          sector:'Media',          industry:'Film Production',        cap:'Micro',foStock:false,nifty500:false,penny:true,  minVolFilter:500000},

  // ── EXPANSION BATCH 1 — HOTELS & HOSPITALITY (missing sector) ─────────────
  {sym:'LEMONTREE.NS',  name:'Lemon Tree Hotels',         sector:'Hotels',         industry:'Mid-Scale Hotels',       cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'CHALET.NS',     name:'Chalet Hotels',             sector:'Hotels',         industry:'Luxury Hotels',          cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'EIHOTEL.NS',    name:'EIH (Oberoi Hotels)',       sector:'Hotels',         industry:'Luxury Hotels',          cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'TAJGVK.NS',     name:'Taj GVK Hotels',            sector:'Hotels',         industry:'Luxury Hotels',          cap:'Small',foStock:false,nifty500:false,penny:false},

  // ── EXPANSION BATCH 2 — DEFENCE & AEROSPACE (underrepresented) ────────────
  {sym:'BDL.NS',        name:'Bharat Dynamics',           sector:'Defence',        industry:'Missiles & Ammunition',  cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'MIDHANI.NS',    name:'Mishra Dhatu Nigam',        sector:'Defence',        industry:'Speciality Alloys',      cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'PARAS.NS',      name:'Paras Defence',             sector:'Defence',        industry:'Defence Electronics',    cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'DATAPATTNS.NS', name:'Data Patterns India',       sector:'Defence',        industry:'Defence Electronics',    cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'GRSE.NS',       name:'Garden Reach Shipbuilders', sector:'Defence',        industry:'Shipbuilding',           cap:'Mid',  foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 3 — RENEWABLES & CLEAN ENERGY ─────────────────────────
  {sym:'TPWR.NS',       name:'Torrent Power',             sector:'Power',          industry:'Power Distribution',     cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'GREENKO.NS',    name:'Greenko Energy',            sector:'Renewables',     industry:'Renewable Energy',       cap:'Mid',  foStock:false,nifty500:false,penny:false},
  {sym:'WAREEENE.NS',   name:'Waaree Energies',           sector:'Renewables',     industry:'Solar Panels',           cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'PREMIER.NS',    name:'Premier Energies',          sector:'Renewables',     industry:'Solar Panels',           cap:'Mid',  foStock:true, nifty500:true, penny:false},

  // ── EXPANSION BATCH 4 — TEXTILES & FASHION ────────────────────────────────
  {sym:'VEDANT.NS',     name:'Vedant Fashions (Manyavar)',sector:'Retail',         industry:'Ethnic Wear',            cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'ARVIND.NS',     name:'Arvind',                    sector:'Textiles',       industry:'Textiles',               cap:'Small',foStock:true, nifty500:true, penny:false},
  {sym:'WELSPUNIND.NS', name:'Welspun India',             sector:'Textiles',       industry:'Home Textiles',          cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'SPORTKING.NS',  name:'Sportking India',           sector:'Textiles',       industry:'Yarn',                   cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'KITEX.NS',      name:'Kitex Garments',            sector:'Textiles',       industry:'Garments Export',        cap:'Small',foStock:false,nifty500:false,penny:false},

  // ── EXPANSION BATCH 5 — QSR & FOOD CHAINS ─────────────────────────────────
  {sym:'DEVYANI.NS',    name:'Devyani International (KFC)',sector:'QSR',           industry:'Restaurants',            cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'WESTLIFE.NS',   name:'Westlife Foodworld (McD)',  sector:'QSR',           industry:'Restaurants',            cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'BURGER.NS',     name:'Burger King India',         sector:'QSR',           industry:'Restaurants',            cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'BARBEQUE.NS',   name:'Barbeque Nation',           sector:'QSR',           industry:'Casual Dining',          cap:'Small',foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 6 — EV & AUTO ANCILLARY EXPANSION ─────────────────────
  {sym:'AMARAJABAT.NS', name:'Amara Raja Energy',         sector:'Auto Ancillary', industry:'Batteries',             cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'OLECTRA.NS',    name:'Olectra Greentech',         sector:'Auto Ancillary', industry:'Electric Buses',        cap:'Small',foStock:true, nifty500:true, penny:false},
  {sym:'GREAVES.NS',    name:'Greaves Cotton',            sector:'Auto Ancillary', industry:'EV Components',         cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'VARROC.NS',     name:'Varroc Engineering',        sector:'Auto Ancillary', industry:'Auto Parts',            cap:'Small',foStock:true, nifty500:true, penny:false},
  {sym:'BALKRISHNA.NS', name:'Balkrishna Industries',     sector:'Auto Ancillary', industry:'Tyres',                 cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'CEATLTD.NS',    name:'CEAT Tyres',                sector:'Auto Ancillary', industry:'Tyres',                 cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'MRF.NS',        name:'MRF',                       sector:'Auto Ancillary', industry:'Tyres',                 cap:'Large',foStock:true, nifty500:true, penny:false},

  // ── EXPANSION BATCH 7 — MISSING LARGE/MID F&O STOCKS ──────────────────────
  {sym:'APTUS.NS',      name:'Aptus Value Housing',       sector:'Housing Finance', industry:'Mortgage Finance',     cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'FINPIPE.NS',    name:'Finolex Industries',        sector:'Industrials',    industry:'PVC Pipes',             cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'KALYANKJIL.NS', name:'Kalyan Jewellers',          sector:'Consumer',       industry:'Jewellery',             cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'SENCO.NS',      name:'Senco Gold',                sector:'Consumer',       industry:'Jewellery',             cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'PCJEWELLER.NS', name:'PC Jeweller',               sector:'Consumer',       industry:'Jewellery',             cap:'Small',foStock:true, nifty500:false,penny:false},
  {sym:'SULA.NS',       name:'Sula Vineyards',            sector:'Consumer',       industry:'Beverages & Alcohol',   cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'RADICO.NS',     name:'Radico Khaitan',            sector:'Consumer',       industry:'Beverages & Alcohol',   cap:'Mid',  foStock:true, nifty500:true, penny:false},

  // ── EXPANSION BATCH 8 — AGROCHEMICALS EXPANSION ───────────────────────────
  {sym:'BAYERCROP.NS',  name:'Bayer CropScience',         sector:'Agrochem',       industry:'Agrochemicals',         cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'DHANUKA.NS',    name:'Dhanuka Agritech',          sector:'Agrochem',       industry:'Agrochemicals',         cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'GHCL.NS',       name:'GHCL',                      sector:'Chemicals',      industry:'Soda Ash',              cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'AARTI.NS',      name:'Aarti Industries',          sector:'Chemicals',      industry:'Specialty Chemicals',   cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'NOCIL.NS',      name:'NOCIL',                     sector:'Chemicals',      industry:'Rubber Chemicals',      cap:'Small',foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 9 — DIAGNOSTIC & HEALTHCARE ───────────────────────────
  {sym:'VIJAYABANK.NS', name:'Vijaya Diagnostic',         sector:'Healthcare',     industry:'Diagnostics',           cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'HEALTHCARE.NS', name:'Healthium Medtech',         sector:'Healthcare',     industry:'Medical Devices',       cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'POLY.NS',       name:'Poly Medicure',             sector:'Healthcare',     industry:'Medical Devices',       cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'DIVI.NS',       name:'Divis Laboratories',        sector:'Pharma',         industry:'API',                   cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'SUVEN.NS',      name:'Suven Pharmaceuticals',     sector:'Pharma',         industry:'CDMO',                  cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'NEULANDLAB.NS', name:'Neuland Laboratories',      sector:'Pharma',         industry:'API',                   cap:'Small',foStock:false,nifty500:false,penny:false},

  // ── EXPANSION BATCH 10 — LOGISTICS & SUPPLY CHAIN ─────────────────────────
  {sym:'BLUEDART.NS',   name:'Blue Dart Express',         sector:'Logistics',      industry:'Courier & Express',     cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'GATEWAY.NS',    name:'Gateway Distriparks',       sector:'Logistics',      industry:'Container Logistics',   cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'ALLCARGO.NS',   name:'Allcargo Logistics',        sector:'Logistics',      industry:'Third Party Logistics', cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'MAHLOG.NS',     name:'Mahindra Logistics',        sector:'Logistics',      industry:'Third Party Logistics', cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'TCI.NS',        name:'Transport Corp of India',   sector:'Logistics',      industry:'Road Freight',          cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'VRLLOG.NS',     name:'VRL Logistics',             sector:'Logistics',      industry:'Road Freight',          cap:'Small',foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 11 — INSURANCE EXPANSION ──────────────────────────────
  {sym:'ICICIPRU.NS',   name:'ICICI Prudential Life',     sector:'Insurance',      industry:'Life Insurance',        cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'HDFCLIFE.NS',   name:'HDFC Life Insurance',       sector:'Insurance',      industry:'Life Insurance',        cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'GODIGIT.NS',    name:'Go Digit General Insurance',sector:'Insurance',      industry:'General Insurance',     cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'STARHEALTH.NS', name:'Star Health Insurance',     sector:'Insurance',      industry:'Health Insurance',      cap:'Mid',  foStock:true, nifty500:true, penny:false},

  // ── EXPANSION BATCH 12 — CAPITAL GOODS EXPANSION ──────────────────────────
  {sym:'CG.NS',         name:'CG Power & Industrial',     sector:'Capital Goods',  industry:'Electrical Equipment',  cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'ISGEC.NS',      name:'ISGEC Heavy Engineering',   sector:'Capital Goods',  industry:'Industrial Equipment',  cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'LTTECHNO.NS',   name:'L&T Technology Services',   sector:'IT',             industry:'Engineering R&D',       cap:'Large',foStock:true, nifty500:true, penny:false},

  // ── EXPANSION BATCH 13 — TRAVEL & AVIATION ────────────────────────────────
  {sym:'MAHAIRPORT.NS', name:'GMR Airports Infrastructure',sector:'Aviation',      industry:'Airport Operations',    cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'EASEMYTRIP.NS', name:'Easy Trip Planners',         sector:'Travel',        industry:'Online Travel',         cap:'Small',foStock:true, nifty500:true, penny:false},
  {sym:'THOMASCOOK.NS', name:'Thomas Cook India',          sector:'Travel',        industry:'Travel Services',       cap:'Small',foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 14 — BANKING EXPANSION (PSU & Small Finance) ──────────
  {sym:'BANKBARODA.NS', name:'Bank of Baroda',            sector:'Banking',        industry:'Public Sector Banks',   cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'UNIONBANK.NS',  name:'Union Bank of India',       sector:'Banking',        industry:'Public Sector Banks',   cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'EQUITASBNK.NS', name:'Equitas Small Finance Bank',sector:'Banking',        industry:'Small Finance Banks',   cap:'Small',foStock:true, nifty500:true, penny:false},
  {sym:'UTKARSHBNK.NS', name:'Utkarsh Small Finance Bank',sector:'Banking',        industry:'Small Finance Banks',   cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'SURYODAY.NS',   name:'Suryoday Small Finance Bank',sector:'Banking',       industry:'Small Finance Banks',   cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'ESAFSFB.NS',    name:'ESAF Small Finance Bank',   sector:'Banking',        industry:'Small Finance Banks',   cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'KTKBANK.NS',    name:'Karnataka Bank',            sector:'Banking',        industry:'Private Banks',         cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'DCBBANK.NS',    name:'DCB Bank',                  sector:'Banking',        industry:'Private Banks',         cap:'Small',foStock:true, nifty500:true, penny:false},

  // ── EXPANSION BATCH 15 — REAL ESTATE EXPANSION ────────────────────────────
  {sym:'NESCO.NS',      name:'Nesco',                     sector:'Realty',         industry:'Exhibition & Office',   cap:'Small',foStock:false,nifty500:false,penny:false},
  {sym:'SUNTECK.NS',    name:'Sunteck Realty',            sector:'Realty',         industry:'Real Estate',           cap:'Small',foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 16 — INTERNET & NEW AGE ───────────────────────────────
  {sym:'POLICYBZR.NS',  name:'PB Fintech (PolicyBazaar)', sector:'Internet',       industry:'InsurTech',             cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'CARTRADE.NS',   name:'CarTrade Tech',             sector:'Internet',       industry:'Auto Marketplace',      cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'INFOBEAN.NS',   name:'Info Edge (Naukri)',         sector:'Internet',       industry:'Job Portal',            cap:'Large',foStock:true, nifty500:true, penny:false},
  {sym:'JUSTDIAL.NS',   name:'Just Dial',                 sector:'Internet',       industry:'Local Search',          cap:'Small',foStock:true, nifty500:true, penny:false},
  {sym:'MAPMYINDIA.NS', name:'MapMyIndia (CE Info Systems)',sector:'Internet',     industry:'Mapping & Location',    cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'IXIGO.NS',      name:'Le Travenues (ixigo)',       sector:'Travel',        industry:'Online Travel',         cap:'Small',foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 17 — SPECIALTY INDUSTRIALS ────────────────────────────
  {sym:'SUPRAJIT.NS',   name:'Suprajit Engineering',      sector:'Auto Ancillary', industry:'Cables & Controls',     cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'JBCHEPHARM.NS', name:'JB Chemicals',              sector:'Pharma',         industry:'Pharma',                cap:'Mid',  foStock:false,nifty500:true, penny:false},
  {sym:'ERIS.NS',       name:'Eris Lifesciences',         sector:'Pharma',         industry:'Chronic Therapy',       cap:'Mid',  foStock:false,nifty500:true, penny:false},

  // ── EXPANSION BATCH 18 — IT MID-CAP EXPANSION ─────────────────────────────
  {sym:'BSOFT.NS',      name:'Birlasoft',                 sector:'IT',             industry:'IT Services',           cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'RATEGAIN.NS',   name:'RateGain Travel Technologies',sector:'IT',           industry:'Travel Tech',           cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'NEWGEN.NS',     name:'Newgen Software',           sector:'IT',             industry:'Enterprise Software',   cap:'Small',foStock:false,nifty500:true, penny:false},
  {sym:'TANLA.NS',      name:'Tanla Platforms',           sector:'IT',             industry:'CPaaS',                 cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'INDIAMART.NS',  name:'IndiaMART InterMESH',       sector:'Internet',       industry:'B2B Marketplace',       cap:'Mid',  foStock:true, nifty500:true, penny:false},
  {sym:'TTML.NS',       name:'Tata Teleservices Maharashtra',sector:'Telecom',     industry:'Telecom Services',      cap:'Small',foStock:false,nifty500:false,penny:false},
];


// ── LIQUIDITY FILTERS ────────────────────────────────────────────────────────
// Applied at scan time, not at definition time
// These are the minimum criteria a stock must pass to enter the scan:
const LIQUIDITY_FILTERS = {
  // Minimum average daily volume (shares traded) over 20 days
  // Large/Mid cap: 50,000 shares; Small cap: 20,000; Micro/Penny: stock-specific minVolFilter
  minAvgVolLarge:  50000,
  minAvgVolMid:    20000,
  minAvgVolSmall:  10000,
  minAvgVolMicro:  500000,  // penny stocks need much higher liquidity

  // Minimum average daily traded value (volume × price), proxy-estimated
  // We enforce this via a minimum volume check since we don't have live mkt cap data
  // Stocks with CMP < ₹10 and avg vol < 5L are excluded
  excludeBelowVol: 100000,  // never scan stocks with avg vol < 1L regardless of cap

  // ── Minimum traded value (turnover), in ₹ lakhs — from NSE Bhav Copy ────────
  // Applied only when bhav copy data is available (NSEDataService); if NSE is
  // unreachable, this filter is skipped (volume-based filters above still apply).
  // Thresholds chosen so a stock must have meaningful daily rupee turnover,
  // not just high share count on a low-priced stock.
  minTurnoverLakhsLarge: 500,   // ₹5 Cr/day minimum for Large cap
  minTurnoverLakhsMid:   200,   // ₹2 Cr/day for Mid cap
  minTurnoverLakhsSmall: 50,    // ₹50 L/day for Small cap
  minTurnoverLakhsMicro: 100,   // ₹1 Cr/day for penny/Micro — higher bar to avoid illiquid penny traps
};

// ── DEDUPLICATION ────────────────────────────────────────────────────────────
const seen = new Set();
const UNIVERSE = RAW_UNIVERSE.filter(s => {
  if (seen.has(s.sym)) return false;
  seen.add(s.sym);
  return true;
});

// ── LOOKUP MAP ───────────────────────────────────────────────────────────────
const UNIVERSE_MAP = {};
UNIVERSE.forEach(s => { UNIVERSE_MAP[s.sym] = s; });

// ── DERIVED LISTS ────────────────────────────────────────────────────────────
const SECTORS    = [...new Set(UNIVERSE.map(s => s.sector))].sort();
const INDUSTRIES = [...new Set(UNIVERSE.map(s => s.industry))].sort();

// ── UNIVERSE STATS ───────────────────────────────────────────────────────────
const UNIVERSE_STATS = {
  total:    UNIVERSE.length,
  nifty500: UNIVERSE.filter(s => s.nifty500).length,
  foStocks: UNIVERSE.filter(s => s.foStock).length,
  large:    UNIVERSE.filter(s => s.cap === 'Large').length,
  mid:      UNIVERSE.filter(s => s.cap === 'Mid').length,
  small:    UNIVERSE.filter(s => s.cap === 'Small').length,
  micro:    UNIVERSE.filter(s => s.cap === 'Micro').length,
  penny:    UNIVERSE.filter(s => s.penny).length,
  sectors:  SECTORS.length,
  industries: INDUSTRIES.length,
};

module.exports = { UNIVERSE, UNIVERSE_MAP, SECTORS, INDUSTRIES, LIQUIDITY_FILTERS, UNIVERSE_STATS };
