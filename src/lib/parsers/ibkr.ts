import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { normalizeSymbol } from "./common";
import type {
  Currency,
  DividendIncome,
  OpenPosition,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  TaxStatementSummary,
  TradeActivity,
} from "@/lib/tax/types";

interface IbkrFileInput {
  name: string;
  data: ArrayBuffer;
}

interface TextToken {
  text: string;
  x: number;
  y: number;
}

interface PageTextToken extends TextToken {
  page: number;
}

interface TextRow {
  page: number;
  x: number;
  text: string;
  tokens: TextToken[];
}

interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
}

interface SecurityInfo {
  symbol: string;
  securityName: string;
  exchange: string;
  market: string;
  type: string;
}

interface IbkrTradeRow {
  sourcePdf: string;
  page: number;
  currency: Currency;
  market: string;
  symbol: string;
  securityName: string;
  tradeDate: string;
  time?: string;
  side: "buy" | "sell";
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  netAmount: number;
  fee: number;
  realizedPnl: number;
  rawCode: string;
}

interface Ibkr1042sEntry {
  sourcePdf: string;
  page: number;
  taxYear: number;
  uniqueId: string;
  incomeCode: string;
  grossIncome: number;
  federalTaxWithheld: number;
}

type Form1042sIncomeCategory = "interest" | "dividend" | "ignored" | "unsupported";

const IBKR_BROKER = "IBKR";
const DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;
const ROW_GROUP_TOLERANCE = 8.2;
const FORM_1042S_INTEREST_CODES = new Set(["01", "02", "03", "04", "05", "22", "29", "30", "31", "33", "51", "54"]);
const FORM_1042S_DIVIDEND_CODES = new Set(["06", "07", "08", "34", "40", "52", "53", "56"]);
const FORM_1042S_IGNORED_CODES = new Set(["37"]);
const FORM_1042S_INCOME_LABELS: Record<string, string> = {
  "01": "Interest paid by U.S. obligors-general",
  "06": "Dividends paid by U.S. corporations-general",
  "33": "Substitute payment-interest",
  "34": "Substitute payment-dividends",
  "37": "Return of capital",
};

const MONTHS: Record<string, string> = {
  一月: "01",
  二月: "02",
  三月: "03",
  四月: "04",
  五月: "05",
  六月: "06",
  七月: "07",
  八月: "08",
  九月: "09",
  十月: "10",
  十一月: "11",
  十二月: "12",
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return value.normalize("NFKC").replaceAll("−", "-").replaceAll("–", "-");
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseNumber(value: string) {
  const text = canonicalText(value).replace(/[()]/g, "");
  const match = text.match(/[+-]?\d[\d,]*(?:\.\d+)?/);
  if (!match) return 0;
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCurrency(value: string): Currency | null {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("HKD") || text.includes("港币") || text.includes("港幣")) return "HKD";
  if (text.includes("CNY") || text.includes("CNH") || text.includes("人民币") || text.includes("人民幣")) return "CNY";
  return null;
}

function rowCell(row: TextRow, minY: number, maxY: number) {
  return clean(
    row.tokens
      .filter((token) => token.y >= minY && token.y < maxY)
      .sort((a, b) => a.y - b.y)
      .map((token) => token.text)
      .join(" "),
  );
}

function firstDate(value: string) {
  return canonicalText(value).match(/20\d{2}[-.]\d{2}[-.]\d{2}/)?.[0].replace(/\./g, "-") ?? "";
}

function firstTime(value: string) {
  return canonicalText(value).match(/\b\d{2}:\d{2}:\d{2}\b/)?.[0] ?? "";
}

function symbolCell(row: TextRow) {
  return rowCell(row, 30, 90);
}

function marketFromExchange(exchange: string, currency: Currency) {
  const text = canonicalText(exchange).toUpperCase();
  if (text.includes("HK") || text.includes("SEHK")) return "HK";
  if (text.includes("NASDAQ") || text.includes("NYSE") || text.includes("AMEX") || text.includes("ARCA")) return "US";
  if (currency === "HKD") return "HK";
  if (currency === "CNY") return "CN";
  return "US";
}

function isTickerLike(symbol: string) {
  if (!symbol || symbol.includes(".")) return false;
  if (symbol === "USD" || symbol === "HKD" || symbol === "CNY" || symbol === "CNH") return false;
  return /^[A-Z][A-Z0-9-]{0,7}$/.test(symbol);
}

function isStockSymbol(symbol: string, securities: Map<string, SecurityInfo>) {
  const known = securities.get(symbol);
  if (known) {
    const type = canonicalText(known.type).toUpperCase();
    return type.includes("COMMON") || type.includes("ADR") || type.includes("股票");
  }
  return isTickerLike(symbol);
}

function securityFor(symbol: string, securities: Map<string, SecurityInfo>, currency: Currency): SecurityInfo {
  return (
    securities.get(symbol) ?? {
      symbol,
      securityName: symbol,
      exchange: "",
      market: marketFromExchange("", currency),
      type: "",
    }
  );
}

async function extractPdfRows(fileName: string, data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  const rows: TextRow[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const tokens = content.items
      .flatMap((item) => {
        const candidate = item as PdfTextItemLike;
        if (typeof candidate.str !== "string" || candidate.str.trim().length === 0) return [];
        if (!Array.isArray(candidate.transform)) return [];
        return [
          {
            text: clean(candidate.str),
            x: Number(candidate.transform[4] ?? 0),
            y: Number(candidate.transform[5] ?? 0),
          },
        ];
      })
      .sort((a, b) => a.x - b.x || a.y - b.y);

    const groups: Array<{ x: number; tokens: TextToken[] }> = [];
    for (const token of tokens) {
      let nearest: { x: number; tokens: TextToken[] } | undefined;
      let nearestDistance = Infinity;
      for (const group of groups) {
        const distance = Math.abs(group.x - token.x);
        if (distance <= ROW_GROUP_TOLERANCE && distance < nearestDistance) {
          nearest = group;
          nearestDistance = distance;
        }
      }
      const group = nearest ?? { x: token.x, tokens: [] };
      if (!nearest) groups.push(group);
      group.tokens.push(token);
      group.x = group.tokens.reduce((sum, item) => sum + item.x, 0) / group.tokens.length;
    }

    rows.push(
      ...groups
        .sort((a, b) => a.x - b.x)
        .map((group) => {
          const sortedTokens = group.tokens.sort((a, b) => a.y - b.y);
          return {
            page: pageNumber,
            x: group.x,
            tokens: sortedTokens,
            text: clean(sortedTokens.map((token) => token.text).join(" ")),
          };
        }),
    );
  }

  if (rows.length === 0) {
    throw new Error(`${fileName} 没有可解析页面`);
  }
  return rows;
}

function parseStatementPeriod(rows: TextRow[]) {
  const monthPattern = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
  const dateRe = new RegExp(`(${monthPattern})\\s+(\\d{1,2}),\\s*(20\\d{2})`, "gi");
  for (const row of rows) {
    const dates = Array.from(canonicalText(row.text).matchAll(dateRe)).map((match) => {
      const month = MONTHS[match[1].toLowerCase()] ?? MONTHS[match[1]];
      return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
    });
    if (dates.length >= 2) {
      return { periodStart: dates[0], periodEnd: dates[1] };
    }
  }
  return {};
}

function pdfTokensByPage(rows: TextRow[]) {
  const pages = new Map<number, PageTextToken[]>();
  for (const row of rows) {
    const pageTokens = pages.get(row.page) ?? [];
    for (const token of row.tokens) {
      pageTokens.push({ ...token, page: row.page });
    }
    pages.set(row.page, pageTokens);
  }
  return pages;
}

function tokenInBox(
  tokens: PageTextToken[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  predicate: (token: PageTextToken) => boolean,
) {
  return tokens
    .filter((token) => token.x >= minX && token.x <= maxX && token.y >= minY && token.y <= maxY && predicate(token))
    .sort((a, b) => b.y - a.y || a.x - b.x)[0];
}

function parse1042sUniqueId(value: string) {
  const match = canonicalText(value).match(/((?:\d\s*){10})\s+UNIQUE FORM IDENTIFIER/i);
  return match?.[1].replace(/\s+/g, "") ?? "";
}

function parseForm1042sEntries(rows: TextRow[], sourcePdf: string) {
  const entries = new Map<string, Ibkr1042sEntry>();
  for (const [page, tokens] of pdfTokensByPage(rows)) {
    const pageText = canonicalText(tokens.map((token) => token.text).join(" "));
    if (!pageText.includes("1042-S") || !pageText.includes("UNIQUE FORM IDENTIFIER")) continue;

    const uniqueId = parse1042sUniqueId(tokens.find((token) => token.text.includes("UNIQUE FORM IDENTIFIER"))?.text ?? "");
    const yearToken = tokenInBox(tokens, 420, 500, 720, 760, (token) => /^20\d{2}$/.test(token.text));
    const incomeCodeToken = tokenInBox(tokens, 25, 65, 670, 685, (token) => /^\d{2}$/.test(token.text));
    const grossIncomeToken = tokenInBox(tokens, 70, 125, 670, 685, (token) => /^\d[\d,.]*$/.test(token.text));
    const taxWithheldToken = tokenInBox(tokens, 150, 215, 640, 655, (token) => /^\d[\d,.]*$/.test(token.text));
    const taxYear = Number(yearToken?.text ?? "");

    if (!uniqueId || !Number.isFinite(taxYear) || !incomeCodeToken || !grossIncomeToken) continue;

    entries.set(uniqueId, {
      sourcePdf,
      page,
      taxYear,
      uniqueId,
      incomeCode: incomeCodeToken.text,
      grossIncome: roundMoney(parseNumber(grossIncomeToken.text)),
      federalTaxWithheld: roundMoney(Math.abs(parseNumber(taxWithheldToken?.text ?? "0"))),
    });
  }

  return Array.from(entries.values()).sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}

function categoryFor1042sIncomeCode(code: string): Form1042sIncomeCategory {
  if (FORM_1042S_INTEREST_CODES.has(code)) return "interest";
  if (FORM_1042S_DIVIDEND_CODES.has(code)) return "dividend";
  if (FORM_1042S_IGNORED_CODES.has(code)) return "ignored";
  return "unsupported";
}

function incomeCodeLabel(code: string) {
  return FORM_1042S_INCOME_LABELS[code] ?? `Income code ${code}`;
}

function formatMoney(value: number) {
  return roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function form1042sSummaries(fileName: string, entries: Ibkr1042sEntry[]) {
  const byYear = new Map<number, Ibkr1042sEntry[]>();
  for (const entry of entries) {
    const group = byYear.get(entry.taxYear) ?? [];
    group.push(entry);
    byYear.set(entry.taxYear, group);
  }

  return Array.from(byYear.entries())
    .sort(([yearA], [yearB]) => yearA - yearB)
    .flatMap<TaxStatementSummary>(([taxYear, yearEntries]) => {
      const countedEntries = yearEntries.filter((entry) => {
        const category = categoryFor1042sIncomeCode(entry.incomeCode);
        return category === "interest" || category === "dividend";
      });
      const interest = countedEntries
        .filter((entry) => categoryFor1042sIncomeCode(entry.incomeCode) === "interest")
        .reduce((sum, entry) => sum + entry.grossIncome, 0);
      const cashDividends = countedEntries
        .filter((entry) => categoryFor1042sIncomeCode(entry.incomeCode) === "dividend")
        .reduce((sum, entry) => sum + entry.grossIncome, 0);
      const dividendTaxWithheld = countedEntries.reduce((sum, entry) => sum + entry.federalTaxWithheld, 0);

      if (!interest && !cashDividends && !dividendTaxWithheld) return [];

      return [
        {
          id: `ibkr-1042s-${taxYear}-${fileName}`,
          broker: IBKR_BROKER,
          source: fileName,
          currency: "USD",
          periodStart: `${taxYear}-01-01`,
          periodEnd: `${taxYear}-12-31`,
          grossProceeds: 0,
          realizedGainLoss: 0,
          cashDividends: roundMoney(cashDividends),
          dividendTaxWithheld: roundMoney(dividendTaxWithheld),
          interest: roundMoney(interest),
        },
      ];
    });
}

function form1042sIssue(summary: TaxStatementSummary, entries: Ibkr1042sEntry[]): ReviewIssue {
  const ignoredEntries = entries.filter((entry) => {
    const category = categoryFor1042sIncomeCode(entry.incomeCode);
    return category === "ignored" || category === "unsupported";
  });
  const ignoredText =
    ignoredEntries.length > 0
      ? `未自动计入的收入代码：${ignoredEntries
          .map((entry) => `${entry.incomeCode} ${incomeCodeLabel(entry.incomeCode)} USD ${formatMoney(entry.grossIncome)}`)
          .join("；")}。请人工核对是否需要调整持仓成本或另行申报。`
      : "";

  return {
    id: `${summary.id}-no-trade-detail`,
    severity: ignoredEntries.length > 0 ? "warning" : "info",
    title: "已解析 IBKR 1042-S 税表",
    detail: `已读取 ${summary.source} 的 ${summary.periodStart?.slice(0, 4) ?? ""} 年 Form 1042-S：利息 USD ${formatMoney(
      summary.interest ?? 0,
    )}，股息 USD ${formatMoney(summary.cashDividends)}，联邦预扣税 USD ${formatMoney(
      summary.dividendTaxWithheld,
    )}。1042-S 只有年度汇总，没有逐笔交易或逐笔分红明细；利息和股息汇总已统计进总体数据，但明细表无法展开。${ignoredText}`,
    source: summary.source,
  };
}

function unsupported1042sIssue(fileName: string, entries: Ibkr1042sEntry[]): ReviewIssue {
  const codes = entries
    .map((entry) => `${entry.incomeCode} ${incomeCodeLabel(entry.incomeCode)} USD ${formatMoney(entry.grossIncome)}`)
    .join("；");
  return {
    id: `ibkr-1042s-${fileName}-unsupported-codes`,
    severity: "warning",
    title: "IBKR 1042-S 暂未计入",
    detail: `已识别 IBKR Form 1042-S，但本文件只包含当前不会自动计入的收入代码：${codes}。请人工核对是否需要调整持仓成本或另行申报。`,
    source: fileName,
  };
}

function parseSecurities(rows: TextRow[]) {
  const securities = new Map<string, SecurityInfo>();
  let inFinancialProducts = false;

  for (const row of rows) {
    const text = canonicalText(row.text);
    if (text.includes("金融产品信息")) {
      inFinancialProducts = true;
      continue;
    }
    if (!inFinancialProducts) continue;
    if (text.includes("术语表") || text.includes("代码 （继续）") || text.includes("代码 (继续)")) break;

    const rawSymbol = symbolCell(row);
    const symbol = normalizeSymbol(rawSymbol);
    const securityName = rowCell(row, 130, 250);
    const exchange = rowCell(row, 455, 510);
    const type = rowCell(row, 595, 635);
    if (!symbol || symbol === "代码" || symbol === "股票" || symbol === "短期国债") continue;
    if (!securityName || (!type.includes("COMMON") && !type.includes("ADR") && !type.includes("股票"))) continue;

    securities.set(symbol, {
      symbol,
      securityName,
      exchange,
      market: marketFromExchange(exchange, "USD"),
      type,
    });
  }

  return securities;
}

function parseTrades(rows: TextRow[], securities: Map<string, SecurityInfo>) {
  const trades: IbkrTradeRow[] = [];
  let activeCurrency: Currency = "USD";
  let seenTradeTable = false;

  for (const row of rows) {
    const first = symbolCell(row);
    const text = canonicalText(row.text);
    if (first === "交易") {
      seenTradeTable = true;
      continue;
    }
    if (!seenTradeTable) continue;
    if (text.includes("公司行动") || text.includes("代扣税") || text.includes("股息") || text.includes("金融产品信息")) break;

    const maybeCurrency = parseCurrency(first);
    if (maybeCurrency) {
      activeCurrency = maybeCurrency;
      continue;
    }

    const symbol = normalizeSymbol(first);
    if (!isStockSymbol(symbol, securities)) continue;
    if (first.startsWith("总数") || symbol === "代码") continue;

    const dateTime = rowCell(row, 125, 225);
    const tradeDate = firstDate(dateTime);
    if (!DATE_RE.test(tradeDate)) continue;

    const quantity = parseNumber(rowCell(row, 285, 315));
    if (!quantity) continue;

    const side = quantity < 0 ? "sell" : "buy";
    const unitPrice = parseNumber(rowCell(row, 315, 365));
    const proceeds = parseNumber(rowCell(row, 425, 475));
    const fee = Math.abs(parseNumber(rowCell(row, 485, 520)));
    const basis = parseNumber(rowCell(row, 530, 570));
    const realizedPnl = parseNumber(rowCell(row, 585, 625));
    const rawCode = rowCell(row, 730, 760);
    const security = securityFor(symbol, securities, activeCurrency);
    const grossAmount = Math.abs(proceeds);
    const netAmount = side === "sell" ? roundMoney(Math.max(0, proceeds - fee)) : roundMoney(Math.abs(basis) || grossAmount + fee);

    trades.push({
      sourcePdf: "",
      page: row.page,
      currency: activeCurrency,
      market: security.market || marketFromExchange(security.exchange, activeCurrency),
      symbol,
      securityName: security.securityName || symbol,
      tradeDate,
      time: firstTime(dateTime) || undefined,
      side,
      quantity: Math.abs(quantity),
      unitPrice,
      grossAmount,
      netAmount,
      fee,
      realizedPnl,
      rawCode,
    });
  }

  return trades;
}

function parseDividends(rows: TextRow[], securities: Map<string, SecurityInfo>, sourcePdf: string) {
  const dividends: DividendIncome[] = [];
  let activeCurrency: Currency = "USD";
  let inAccruedDividends = false;

  for (const row of rows) {
    const first = symbolCell(row);
    const text = canonicalText(row.text);
    if (text.includes("应计股息的变化")) {
      inAccruedDividends = true;
      continue;
    }
    if (!inAccruedDividends) continue;
    if (text.includes("金融产品信息") || text.includes("术语表")) break;

    const maybeCurrency = parseCurrency(first);
    if (maybeCurrency) {
      activeCurrency = maybeCurrency;
      continue;
    }

    const rawCode = rowCell(row, 735, 760);
    if (!rawCode.includes("Po")) continue;

    const symbol = normalizeSymbol(first);
    if (!isStockSymbol(symbol, securities)) continue;

    const paymentDate = firstDate(rowCell(row, 250, 320)) || firstDate(rowCell(row, 110, 155));
    const grossAmount = parseNumber(rowCell(row, 625, 670));
    const taxWithheld = Math.abs(parseNumber(rowCell(row, 430, 470)));
    const fee = Math.abs(parseNumber(rowCell(row, 500, 525)));
    if (!DATE_RE.test(paymentDate) || (!grossAmount && !taxWithheld)) continue;

    const security = securityFor(symbol, securities, activeCurrency);
    dividends.push({
      id: `ibkr-dividend-${paymentDate}-${dividends.length}-${symbol}`,
      broker: IBKR_BROKER,
      date: paymentDate,
      currency: activeCurrency,
      symbol,
      securityName: security.securityName || symbol,
      grossAmount: roundMoney(grossAmount),
      taxWithheld: roundMoney(taxWithheld),
      fee: roundMoney(fee),
      source: `${sourcePdf}#p${row.page}`,
      note: "IBKR 活动账单应计股息记录",
    });
  }

  return dividends;
}

function parseOpenPositions(
  rows: TextRow[],
  securities: Map<string, SecurityInfo>,
  sourcePdf: string,
  periodEnd?: string,
) {
  const positions: OpenPosition[] = [];
  let activeCurrency: Currency = "USD";
  let inOpenPositions = false;

  for (const row of rows) {
    const first = symbolCell(row);
    const text = canonicalText(row.text);
    if (text.includes("未平仓持仓")) {
      inOpenPositions = true;
      continue;
    }
    if (!inOpenPositions) continue;
    if (first === "交易" || text.includes("公司行动")) break;

    const maybeCurrency = parseCurrency(first);
    if (maybeCurrency) {
      activeCurrency = maybeCurrency;
      continue;
    }

    const symbol = normalizeSymbol(first);
    if (!isStockSymbol(symbol, securities)) continue;
    if (first.startsWith("总数") || symbol === "代码") continue;

    const quantity = parseNumber(rowCell(row, 240, 285));
    const marketValue = parseNumber(rowCell(row, 585, 625));
    if (!quantity || !marketValue) continue;

    const costBasis = parseNumber(rowCell(row, 420, 465));
    const unrealizedGainLoss = parseNumber(rowCell(row, 675, 715));
    const security = securityFor(symbol, securities, activeCurrency);

    positions.push({
      id: `ibkr-open-${periodEnd ?? "unknown"}-${activeCurrency}-${symbol}`,
      broker: IBKR_BROKER,
      asOf: periodEnd ?? "",
      market: security.market || marketFromExchange(security.exchange, activeCurrency),
      currency: activeCurrency,
      symbol,
      securityName: security.securityName || symbol,
      quantity,
      marketValue: roundMoney(marketValue),
      costBasis: costBasis ? roundMoney(costBasis) : undefined,
      unrealizedGainLoss: unrealizedGainLoss ? roundMoney(unrealizedGainLoss) : undefined,
      source: `${sourcePdf}#p${row.page}`,
      note: "IBKR 活动账单期末持仓；未实现盈亏不计入资本利得。",
    });
  }

  return positions;
}

function tradeActivityFromRow(row: IbkrTradeRow, sequence: number): TradeActivity {
  return {
    id: `ibkr-activity-${row.tradeDate}-${sequence}-${row.symbol}-${row.side}`,
    broker: IBKR_BROKER,
    date: row.tradeDate,
    time: row.time,
    sequence,
    market: row.market,
    currency: row.currency,
    symbol: row.symbol,
    securityName: row.securityName,
    side: row.side,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    grossAmount: row.grossAmount,
    fee: row.fee,
    amount: row.netAmount,
    source: `${row.sourcePdf}#p${row.page}`,
    note: `IBKR 活动账单股票交易${row.rawCode ? `；代码 ${row.rawCode}` : ""}`,
    excludedFromTaxReplay: true,
  };
}

function realizedTradeFromRow(row: IbkrTradeRow, sequence: number): RealizedTrade | null {
  if (row.side !== "sell") return null;
  const proceeds = roundMoney(row.netAmount);
  const costBasis = roundMoney(proceeds - row.realizedPnl);
  return {
    id: `ibkr-reported-${row.tradeDate}-${sequence}-${row.symbol}`,
    broker: IBKR_BROKER,
    sellDate: row.tradeDate,
    time: row.time,
    sequence,
    market: row.market,
    currency: row.currency,
    symbol: row.symbol,
    securityName: row.securityName,
    quantity: row.quantity,
    proceeds,
    costBasis,
    gainLoss: roundMoney(row.realizedPnl),
    source: `${row.sourcePdf}#p${row.page}`,
    note: "使用 IBKR 活动账单“已实现的损益”列；卖出收入已扣除佣金/税。",
    useBrokerReportedGainLoss: true,
  };
}

function isIbkrStatement(rows: TextRow[]) {
  const text = rows.map((row) => canonicalText(row.text)).join("\n");
  return (
    text.includes("Interactive Brokers") ||
    text.includes("盈透证券") ||
    (text.includes("活动账单") && text.includes("账户信息"))
  );
}

function aggregateIssue(
  fileName: string,
  trades: IbkrTradeRow[],
  dividends: DividendIncome[],
  positions: OpenPosition[],
): ReviewIssue {
  const buys = trades.filter((trade) => trade.side === "buy").length;
  const sells = trades.filter((trade) => trade.side === "sell");
  const realizedPnl = sells.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const dividendGross = dividends.reduce((sum, dividend) => sum + dividend.grossAmount, 0);
  const dividendTax = dividends.reduce((sum, dividend) => sum + dividend.taxWithheld, 0);
  return {
    id: `ibkr-${fileName}-parsed`,
    severity: "info",
    title: "已解析 IBKR 活动账单",
    detail: `读取股票买入 ${buys} 笔、卖出 ${sells.length} 笔，券商已实现盈亏合计 ${realizedPnl.toFixed(2)}。分红 ${dividends.length} 笔，税前 ${dividendGross.toFixed(2)}，预扣税 ${dividendTax.toFixed(2)}。期末持仓 ${positions.length} 条。`,
    source: fileName,
  };
}

export async function parseIbkrPdfs(files: IbkrFileInput[]): Promise<ParsedInput> {
  const parsed = emptyParsedInput();

  for (const file of files) {
    try {
      const rows = await extractPdfRows(file.name, file.data);
      const statementDetected = isIbkrStatement(rows);
      const form1042sEntries = parseForm1042sEntries(rows, file.name);
      const taxSummaries = form1042sSummaries(file.name, form1042sEntries);
      const period = parseStatementPeriod(rows);
      const securities = parseSecurities(rows);
      const trades = parseTrades(rows, securities).map((trade) => ({ ...trade, sourcePdf: file.name }));
      const dividends = parseDividends(rows, securities, file.name);
      const positions = parseOpenPositions(rows, securities, file.name, period.periodEnd);

      trades.forEach((trade, index) => {
        parsed.tradeActivities.push(tradeActivityFromRow(trade, index));
        const realizedTrade = realizedTradeFromRow(trade, index);
        if (realizedTrade) parsed.realizedTrades.push(realizedTrade);
      });
      parsed.dividends.push(...dividends);
      parsed.openPositions.push(...positions);
      parsed.taxStatementSummaries.push(...taxSummaries);

      for (const summary of taxSummaries) {
        const taxYear = Number(summary.periodStart?.slice(0, 4));
        parsed.issues.push(form1042sIssue(summary, form1042sEntries.filter((entry) => entry.taxYear === taxYear)));
      }

      if (trades.length > 0 || dividends.length > 0 || positions.length > 0) {
        parsed.issues.push(aggregateIssue(file.name, trades, dividends, positions));
      } else if (form1042sEntries.length > 0) {
        if (taxSummaries.length === 0) {
          parsed.issues.push(unsupported1042sIssue(file.name, form1042sEntries));
        }
      } else if (statementDetected) {
        parsed.issues.push({
          id: "ibkr-no-stock-activity",
          severity: "info",
          title: "本期没有 IBKR 股票交易",
          detail: "已识别为 IBKR 活动账单，但没有读取到股票交易、分红或期末持仓。外汇和短债记录不会计入股票资本利得。",
          source: file.name,
        });
      } else {
        parsed.issues.push({
          id: `ibkr-${file.name}-unsupported`,
          severity: "blocking",
          title: "IBKR 文件格式不符合要求",
          detail: "当前仅支持 IBKR/盈透证券 PDF Activity Statement / 活动账单，或 Form 1042-S 税表。",
          source: file.name,
        });
      }
    } catch (error) {
      parsed.issues.push({
        id: `ibkr-${file.name}-pdf-error`,
        severity: "blocking",
        title: "IBKR PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  return parsed;
}
