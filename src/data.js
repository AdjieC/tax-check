import { TAX_YEAR_FX_RATES } from "./lib/tax/config";

export const TAX_YEAR = 2025;

export const FX_BY_YEAR = Object.fromEntries(
  Object.entries(TAX_YEAR_FX_RATES).map(([year, item]) => [
    Number(year),
    {
      HK: item.fxRates.HKD,
      US: item.fxRates.USD,
      date: item.date,
      source: item.source,
      basisLabel: item.provisional ? "临时中间价" : "年末中间价",
      scopeLabel: item.provisional ? "临时折算口径" : "年末口径",
    },
  ]),
);

export function fxForTaxYear(year) {
  return FX_BY_YEAR[year] ?? FX_BY_YEAR[TAX_YEAR];
}

export const FX = fxForTaxYear(TAX_YEAR);

export const TAX_RATE = 0.2;
export const DIVIDEND_RMB = 1142.91;

export const COST_METHODS = [
  {
    id: "fifo",
    label: "自然年 · FIFO",
    tag: "FIFO",
    description: "先进先出 · 自然年 1/1-12/31",
    factor: 1,
  },
  {
    id: "acb",
    label: "自然年 · ACB",
    tag: "ACB",
    description: "平均成本 · 自然年 1/1-12/31",
    factor: 0.9323,
  },
];

export const BROKER_FILES = [
  {
    id: "futu-2024",
    name: "富途证券_年度清单_2024.xlsx",
    broker: "富途证券",
    type: "年度清单",
    rows: 318,
    status: "已解析",
  },
  {
    id: "tiger-2024-12",
    name: "老虎证券_月结单_12月.xls",
    broker: "老虎证券",
    type: "月结单",
    rows: 64,
    status: "已解析",
  },
  {
    id: "ibkr-2024",
    name: "IBKR_AnnualStatement_2024.csv",
    broker: "IBKR",
    type: "年度清单",
    rows: 142,
    status: "已解析",
  },
];

export const PNL_ROWS = [
  { market: "HK", code: "00700", name: "腾讯控股", currency: "HKD", pnlOriginal: 24673.91 },
  { market: "US", code: "NVDA", name: "英伟达", currency: "USD", pnlOriginal: 6184.2 },
  { market: "HK", code: "02319", name: "蒙牛乳业", currency: "HKD", pnlOriginal: 28795.06 },
  { market: "US", code: "AAPL", name: "苹果", currency: "USD", pnlOriginal: 3092.55 },
  { market: "HK", code: "09988", name: "阿里巴巴-SW", currency: "HKD", pnlOriginal: 11533.24 },
  { market: "US", code: "TSLA", name: "特斯拉", currency: "USD", pnlOriginal: -1880.4 },
  { market: "HK", code: "01810", name: "小米集团-W", currency: "HKD", pnlOriginal: 13335.61 },
  { market: "US", code: "MSFT", name: "微软", currency: "USD", pnlOriginal: 2410.18 },
  { market: "HK", code: "00388", name: "香港交易所", currency: "HKD", pnlOriginal: 9145.58 },
  { market: "US", code: "GOOGL", name: "谷歌-A", currency: "USD", pnlOriginal: 1772.34 },
  { market: "HK", code: "02318", name: "中国平安", currency: "HKD", pnlOriginal: 5396.21 },
  { market: "US", code: "AMZN", name: "亚马逊", currency: "USD", pnlOriginal: -985.62 },
  { market: "HK", code: "00939", name: "建设银行", currency: "HKD", pnlOriginal: 3674.5 },
  { market: "US", code: "META", name: "Meta", currency: "USD", pnlOriginal: 4128.77 },
  { market: "HK", code: "01024", name: "快手-W", currency: "HKD", pnlOriginal: -2486 },
  { market: "US", code: "KO", name: "可口可乐", currency: "USD", pnlOriginal: 842.19 },
  { market: "HK", code: "03968", name: "招商银行", currency: "HKD", pnlOriginal: 2571.72 },
  { market: "US", code: "COST", name: "好市多", currency: "USD", pnlOriginal: 1936.45 },
  { market: "HK", code: "00857", name: "中国石油股份", currency: "HKD", pnlOriginal: -1377.86 },
  { market: "US", code: "AMD", name: "超威半导体", currency: "USD", pnlOriginal: -1430.55 },
];

export const DIVIDENDS = [
  { market: "HK", code: "00700", name: "腾讯控股", currency: "HKD", perShare: "HKD 4.20", withholding: "0%", netOriginal: "HKD 504.00", rmb: 466.96 },
  { market: "US", code: "AAPL", name: "苹果", currency: "USD", perShare: "USD 0.99", withholding: "10%", netOriginal: "USD 26.73", rmb: 192.16 },
  { market: "HK", code: "00388", name: "香港交易所", currency: "HKD", perShare: "HKD 5.36", withholding: "0%", netOriginal: "HKD 160.80", rmb: 148.98 },
  { market: "US", code: "MSFT", name: "微软", currency: "USD", perShare: "USD 0.83", withholding: "10%", netOriginal: "USD 17.93", rmb: 128.89 },
  { market: "HK", code: "02318", name: "中国平安", currency: "HKD", perShare: "HKD 2.42", withholding: "10%", netOriginal: "HKD 130.68", rmb: 121.08 },
  { market: "US", code: "KO", name: "可口可乐", currency: "USD", perShare: "USD 0.485", withholding: "10%", netOriginal: "USD 13.10", rmb: 94.16 },
];

export const EXCLUDED_RECORDS = [
  { market: "HK", code: "03690", name: "美团-W", reason: "期权对冲，非投资性持仓", original: "HKD -8,420.00", rmb: -7801.13, tag: "期权对冲" },
  { market: "US", code: "BABA", name: "阿里巴巴", reason: "老股回拨，成本不可考", original: "USD 1,524.00", rmb: 10955.12, tag: "老股回拨" },
  { market: "HK", code: "02800", name: "盈富基金", reason: "ETF，按口径不计入", original: "HKD 612.00", rmb: 567.02, tag: "ETF" },
  { market: "US", code: "TLT", name: "iShares 20+ 国债", reason: "债券类，单独申报", original: "USD -205.00", rmb: -1473.62, tag: "债券" },
];

export const POSITIONS = [
  { market: "HK", code: "00700", name: "腾讯控股", currency: "HKD", qty: 300, cost: 362.4, last: 418.6 },
  { market: "US", code: "NVDA", name: "英伟达", currency: "USD", qty: 60, cost: 98.2, last: 134.25 },
  { market: "HK", code: "01810", name: "小米集团-W", currency: "HKD", qty: 4000, cost: 18.3, last: 29.05 },
  { market: "US", code: "AAPL", name: "苹果", currency: "USD", qty: 80, cost: 212.5, last: 243.85 },
  { market: "HK", code: "09988", name: "阿里巴巴-SW", currency: "HKD", qty: 1000, cost: 78.4, last: 84.55 },
  { market: "US", code: "MSFT", name: "微软", currency: "USD", qty: 30, cost: 401.2, last: 438.1 },
  { market: "HK", code: "02318", name: "中国平安", currency: "HKD", qty: 1200, cost: 43.1, last: 47.55 },
  { market: "US", code: "TSLA", name: "特斯拉", currency: "USD", qty: 40, cost: 248.6, last: 421.3 },
];

export const FLOW_STOCKS = [
  ["HK", "00700", "腾讯控股", "HKD"],
  ["US", "NVDA", "英伟达", "USD"],
  ["HK", "01810", "小米集团-W", "HKD"],
  ["US", "AAPL", "苹果", "USD"],
  ["HK", "09988", "阿里巴巴-SW", "HKD"],
  ["US", "TSLA", "特斯拉", "USD"],
  ["HK", "02318", "中国平安", "HKD"],
  ["US", "MSFT", "微软", "USD"],
  ["HK", "00388", "香港交易所", "HKD"],
  ["US", "META", "Meta", "USD"],
  ["HK", "02319", "蒙牛乳业", "HKD"],
  ["US", "GOOGL", "谷歌-A", "USD"],
];

export const MONTHS = [
  ["01", "ok"],
  ["02", "ok"],
  ["03", "ok"],
  ["04", "ok"],
  ["05", "ok"],
  ["06", "ok"],
  ["07", "gap"],
  ["08", "ok"],
  ["09", "ok"],
  ["10", "ok"],
  ["11", "ok"],
  ["12", "ok"],
];
