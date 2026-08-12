import { emptyParsedInput } from "@/lib/tax/calculator";
import type {
  CostBasisRequest,
  Currency,
  DividendIncome,
  OpenPosition,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  TradeActivity,
} from "@/lib/tax/types";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { normalizeSymbol } from "./common";

interface ZunjiaFileInput {
  name: string;
  data: ArrayBuffer;
}

export interface ManualCostInput {
  id: string;
  costBasis: number;
}

interface TextToken {
  text: string;
  x: number;
  y: number;
}

interface TextLine {
  page: number;
  text: string;
  tokens: TextToken[];
}

interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
}

interface TradeRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  orderId: string;
  date: string;
  time?: string;
  currency: Currency;
  market: string;
  symbol: string;
  securityName: string;
  side: "buy" | "sell";
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  fee: number;
  amount: number;
}

interface PositionRecord {
  sourcePdf: string;
  page: number;
  statementDate: string;
  currency: Currency;
  market: string;
  symbol: string;
  securityName: string;
  quantity: number;
  closingPrice: number;
  marketValue: number;
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  date: string;
  time?: string;
  flowType: string;
  currency: Currency;
  amount: number;
  note: string;
}

interface ZunjiaRawData {
  trades: TradeRecord[];
  positions: PositionRecord[];
  cashFlows: CashFlowRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface StatementTradeSummary
  extends Partial<Record<"buyGross" | "buyFee" | "buyCommission" | "sellGross" | "sellFee" | "sellCommission", number>> {
  tradeGross?: number;
  tradeFee?: number;
}

interface PositionValues {
  quantity: number;
  closingPrice: number;
  marketValue: number;
}

interface MissingCostRecord {
  id: string;
  sellDate: string;
  time?: string;
  sequence?: number;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  trackedQuantity: number;
  proceeds: number;
  source: string;
}

const ZUNJIA_BROKER = "尊嘉";
const NUMBER_PATTERN = /^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/;
const ORDER_ID_PATTERN = /^\d{8,}$/;
const SPACED_NUMBER_PATTERN = "[+-]?\\d[\\d,\\s]*(?:\\.\\s*\\d[\\d\\s]*)?";

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("帳", "账")
    .replaceAll("賬", "账")
    .replaceAll("戶", "户")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("證", "证")
    .replaceAll("券", "券")
    .replaceAll("幣", "币")
    .replaceAll("種", "种")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("紅", "红")
    .replaceAll("餘", "余")
    .replaceAll("馀", "余")
    .replaceAll("價", "价")
    .replaceAll("數", "数")
    .replaceAll("總", "总")
    .replaceAll("額", "额")
    .replaceAll("−", "-");
}

function compactText(value: string) {
  return canonicalText(value).replace(/\s+/g, "");
}

function compactNumericText(value: string) {
  return canonicalText(value).replace(/\s+/g, "");
}

function parseNumber(value: string) {
  const normalized = canonicalText(value).replace(/,/g, "").replace(/[()]/g, "").replace(/[^0-9.+-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元") || text.includes("美股")) return "USD";
  if (text.includes("CNY") || text.includes("CNH") || text.includes("人民币") || text.includes("A股")) return "CNY";
  return "HKD";
}

function marketName(currency: Currency) {
  if (currency === "USD") return "美国市场";
  if (currency === "CNY") return "A股通";
  return "香港市场";
}

function normalizeDate(value: string) {
  const text = canonicalText(value);
  const match = text.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?/);
  if (!match) return "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeTime(value: string) {
  const match = canonicalText(value).match(/\b((?:[01]\s*\d|2\s*[0-3])\s*:\s*[0-5]\s*\d(?:\s*:\s*[0-5]\s*\d)?)\b/);
  return match ? match[1].replace(/\s+/g, "") : "";
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

function numericTokens(line: TextLine, minX = 0, maxX = Number.POSITIVE_INFINITY) {
  return line.tokens.filter(
    (token) => token.x >= minX && token.x < maxX && NUMBER_PATTERN.test(compactNumericText(token.text)),
  );
}

function isZunjiaStatement(lines: TextLine[]) {
  const text = canonicalText(lines.map((line) => line.text).join("\n"));
  const lower = text.toLowerCase();
  return (
    text.includes("尊嘉证券国际有限公司") ||
    text.includes("尊嘉金融") ||
    lower.includes("zunjia securities") ||
    (text.includes("账户月结单") && (lower.includes("3169-0319") || lower.includes("400-031-0319")))
  );
}

function statementDateFromLines(lines: TextLine[]) {
  const headingIndex = lines.findIndex((line) => compactText(line.text).includes("账户月结单"));
  const candidates = headingIndex >= 0 ? lines.slice(Math.max(0, headingIndex - 2), headingIndex + 5) : lines.slice(0, 30);
  for (const line of candidates) {
    const date = normalizeDate(line.text);
    if (date) return date;
  }

  const text = canonicalText(lines.slice(0, 80).map((line) => line.text).join("\n"));
  const endDate = text.match(/月末净资产\s*(20\d{2}\s*-\s*\d{1,2}\s*-\s*\d{1,2})/);
  return endDate ? normalizeDate(endDate[1]) : "";
}

function securityFromText(value: string, fallbackCurrency: Currency) {
  const text = canonicalText(value).toUpperCase();
  const hkMatch = text.match(/\b(\d{4,5})\s*\.\s*HK\b/);
  if (hkMatch) {
    return {
      symbol: normalizeSymbol(hkMatch[1]),
      currency: "HKD" as Currency,
      market: marketName("HKD"),
    };
  }

  const usSuffixMatch = text.match(/\b([A-Z][A-Z0-9.-]{0,11})\s*\.\s*(?:US|NASDAQ|NYSE|AMEX)\b/);
  if (usSuffixMatch) {
    return {
      symbol: usSuffixMatch[1],
      currency: "USD" as Currency,
      market: marketName("USD"),
    };
  }

  const cnMatch = text.match(/\b((?:SH|SZ)?\d{6})\s*\.\s*(?:SH|SZ|SS)\b/);
  if (cnMatch) {
    return {
      symbol: cnMatch[1].replace(/^(?:SH|SZ)/, ""),
      currency: "CNY" as Currency,
      market: marketName("CNY"),
    };
  }

  const bareUsMatch =
    fallbackCurrency === "USD" ? text.match(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9.-]{0,9})(?:$|[^A-Z0-9.-])/) : null;
  if (bareUsMatch && !["USD", "NYSE", "NASDAQ"].includes(bareUsMatch[1])) {
    return {
      symbol: bareUsMatch[1],
      currency: "USD" as Currency,
      market: marketName("USD"),
    };
  }
  return null;
}

async function extractPdfLines(fileName: string, data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
    disableWorker: typeof window === "undefined",
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;

  try {
    const lines: TextLine[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
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
          .sort((a, b) => b.y - a.y || a.x - b.x);

        const groups: Array<{ y: number; tokens: TextToken[] }> = [];
        for (const token of tokens) {
          let group = groups.find((candidate) => Math.abs(candidate.y - token.y) < 2.2);
          if (!group) {
            group = { y: token.y, tokens: [] };
            groups.push(group);
          }
          group.tokens.push(token);
        }

        lines.push(
          ...groups
            .sort((a, b) => b.y - a.y)
            .map((group) => {
              const sortedTokens = group.tokens.sort((a, b) => a.x - b.x);
              return {
                page: pageNumber,
                text: clean(sortedTokens.map((token) => token.text).join(" ")),
                tokens: sortedTokens,
              };
            }),
        );
      } finally {
        page.cleanup?.();
      }
    }
    if (lines.length === 0) throw new Error(`${fileName} 没有可解析文字层`);
    return lines;
  } finally {
    await document.destroy?.();
  }
}

function positionValuesFromLine(line: TextLine): PositionValues | null {
  const values = numericTokens(line, 300);
  if (values.length < 3) return null;
  const quantity = Math.abs(parseNumber(values[0].text));
  const closingPrice = Math.abs(parseNumber(values[1].text));
  const marketValue = Math.abs(parseNumber(values[values.length - 1].text));
  if (quantity <= 0 || closingPrice <= 0 || marketValue < 0) return null;
  return { quantity, closingPrice, marketValue };
}

function parseCashFlowLine(
  sourcePdf: string,
  line: TextLine,
  date: string,
  time: string,
  sequence: number,
): CashFlowRecord | null {
  const flowType = canonicalText(lineCell(line, 145, 245));
  const currencyText = canonicalText(lineCell(line, 230, 325));
  const amountToken = numericTokens(line, 300, 565)[0];
  if (!date || !flowType || !amountToken || !/(港币|港元|美元|人民币|HKD|USD|CNY)/i.test(currencyText)) return null;
  if (/^(类型|币种|金额|合计)$/.test(flowType)) return null;

  const note = canonicalText(lineCell(line, 520, Number.POSITIVE_INFINITY));
  const rawAmount = Math.abs(parseNumber(amountToken.text));
  if (rawAmount <= 0) return null;
  const negative = /提取|支出|扣|税|费用|withdraw|paid/i.test(`${flowType} ${note}`);
  return {
    sourcePdf,
    page: line.page,
    sequence,
    date,
    time: time || undefined,
    flowType,
    currency: mapCurrency(currencyText),
    amount: negative ? -rawAmount : rawAmount,
    note,
  };
}

function tradeSide(value: string): "buy" | "sell" | null {
  const text = canonicalText(value).toLowerCase();
  if (/卖出|沽出|\bsell\b/.test(text)) return "sell";
  if (/买入|购入|\bbuy\b/.test(text)) return "buy";
  return null;
}

function normalizeSecurityName(value: string) {
  return canonicalText(value).replace(/\s*-\s*/g, "-");
}

function securityNameNearTrade(lines: TextLine[], index: number, symbol: string) {
  const line = lines[index];
  for (const offset of [0, 1, 2, 3]) {
    const candidate = lines[index - offset];
    if (!candidate || candidate.page !== line.page) break;
    const value = normalizeSecurityName(lineCell(candidate, 0, 175));
    if (!value || value.includes(symbol) || normalizeDate(value) || tradeSide(value)) continue;
    if (/^(股票|交易时间|港币|港元|美元|人民币)$/.test(value)) continue;
    return value;
  }
  return symbol;
}

function securityNearTrade(lines: TextLine[], index: number, fallbackCurrency: Currency) {
  const page = lines[index]?.page;
  for (const offset of [1, 2, 3, 0, -1, -2, -3]) {
    const candidate = lines[index + offset];
    if (!candidate || candidate.page !== page) continue;
    const security = securityFromText(candidate.text, fallbackCurrency);
    if (security) return security;
  }
  return null;
}

function tradeFeeFromLine(line: TextLine) {
  const text = canonicalText(line.text);
  if (!/交收费\s*[:：]/.test(text)) return null;
  const labels = ["交收费", "证监会费", "交易活动费", "交易费", "交易征费", "财汇局征费", "平台使用费", "印花税", "期权监管费", "佣金", "暗盘费用"];
  let total = 0;
  let supplemental = 0;
  let matched = 0;
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:：]\\s*(${SPACED_NUMBER_PATTERN})`));
    if (!match) continue;
    const amount = Math.abs(parseNumber(match[1]));
    total += amount;
    if (label === "暗盘费用") supplemental += amount;
    matched += 1;
  }
  return matched > 0 ? { total: roundMoney(total), supplemental: roundMoney(supplemental) } : null;
}

function allocateTradeGroupFee(trades: TradeRecord[], totalFee: number) {
  const totalGross = trades.reduce((sum, trade) => sum + trade.grossAmount, 0);
  if (trades.length === 0 || totalGross <= 0) return;
  let allocated = 0;
  for (const [index, trade] of trades.entries()) {
    const fee =
      index === trades.length - 1
        ? roundMoney(totalFee - allocated)
        : roundMoney((totalFee * trade.grossAmount) / totalGross);
    allocated = roundMoney(allocated + fee);
    trade.fee = fee;
    trade.amount = roundMoney(trade.side === "buy" ? trade.grossAmount + fee : trade.grossAmount - fee);
  }
}

function statementTradeSummary(lines: TextLine[]) {
  const summary: StatementTradeSummary = {};
  for (const line of lines) {
    const text = canonicalText(line.text);
    const tradeGross = text.match(new RegExp(`(?:^|\\s)成交金额\\s*[:：]\\s*(${SPACED_NUMBER_PATTERN})\\s*(?:港元|港币|美元|人民币|HKD|USD|CNY)?`));
    const tradeFee = text.match(new RegExp(`合计费用\\s*[:：]\\s*(${SPACED_NUMBER_PATTERN})\\s*(?:港元|港币|美元|人民币|HKD|USD|CNY)?`));
    if (tradeGross) summary.tradeGross = parseNumber(tradeGross[1]);
    if (tradeFee) summary.tradeFee = parseNumber(tradeFee[1]);

    const side = text.includes("买入总金额") ? "buy" : text.includes("卖出总金额") ? "sell" : null;
    if (!side) continue;
    const gross = text.match(new RegExp(`${side === "buy" ? "买入" : "卖出"}总金额\\s*[:：]\\s*(${SPACED_NUMBER_PATTERN})`));
    const fee = text.match(new RegExp(`${side === "buy" ? "买入" : "卖出"}总费用\\s*[:：]\\s*(${SPACED_NUMBER_PATTERN})`));
    const commission = text.match(new RegExp(`佣金\\s*[:：]\\s*(${SPACED_NUMBER_PATTERN})`));
    if (gross) summary[`${side}Gross`] = parseNumber(gross[1]);
    if (fee) summary[`${side}Fee`] = parseNumber(fee[1]);
    if (commission) summary[`${side}Commission`] = parseNumber(commission[1]);
  }
  return summary;
}

function totalFeeIncludingCommission(fee?: number, commission?: number) {
  if (fee === undefined) return undefined;
  return roundMoney((fee ?? 0) + (commission ?? 0));
}

function valuesWithOptional(value?: number) {
  return value === undefined ? [] : [value];
}

function parseTradeCandidate(
  sourcePdf: string,
  lines: TextLine[],
  index: number,
  currentDate: string,
  currentCurrency: Currency,
  sequence: number,
): TradeRecord | null {
  const line = lines[index];
  const side = tradeSide(line.text);
  const date = normalizeDate(line.text) || currentDate;
  if (!side || !date) return null;
  const security = securityNearTrade(lines, index, currentCurrency);
  const orderIdIndex = line.tokens.findIndex((token) => ORDER_ID_PATTERN.test(compactNumericText(token.text)));
  if (!security || orderIdIndex < 0) return null;
  const orderId = compactNumericText(line.tokens[orderIdIndex].text);
  const [priceToken, quantityToken, amountToken] = line.tokens
    .slice(orderIdIndex + 1)
    .filter((token) => NUMBER_PATTERN.test(compactNumericText(token.text)));
  if (!priceToken || !quantityToken || !amountToken) return null;
  const unitPrice = Math.abs(parseNumber(priceToken.text));
  const quantity = Math.abs(parseNumber(quantityToken.text));
  const reportedGross = Math.abs(parseNumber(amountToken.text));
  const calculatedGross = roundMoney(quantity * unitPrice);
  if (quantity <= 0 || unitPrice <= 0 || Math.abs(calculatedGross - reportedGross) > 0.02) return null;
  const grossAmount = roundMoney(reportedGross);

  return {
    sourcePdf,
    page: line.page,
    sequence,
    orderId,
    date,
    time: normalizeTime(line.text) || undefined,
    currency: security.currency,
    market: security.market,
    symbol: security.symbol,
    securityName: securityNameNearTrade(lines, index, security.symbol),
    side,
    quantity,
    unitPrice,
    grossAmount,
    fee: 0,
    amount: grossAmount,
  };
}

function parseZunjiaLines(sourcePdf: string, lines: TextLine[], baseSequence: number): ZunjiaRawData {
  const statementDate = statementDateFromLines(lines);
  const raw: ZunjiaRawData = {
    trades: [],
    positions: [],
    cashFlows: [],
    issues: [],
    statementDetected: isZunjiaStatement(lines),
  };
  let activeTable: "none" | "trade" | "cash_flow" | "portfolio" = "none";
  let currentCurrency: Currency = "HKD";
  let currentDate = "";
  let currentTime = "";
  let pendingPositionName = "";
  let pendingPositionValues: PositionValues | null = null;
  let pendingTradeGroup: TradeRecord[] = [];
  const supplementalFees: Record<"buy" | "sell", number> = { buy: 0, sell: 0 };
  let sequence = baseSequence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = canonicalText(line.text);
    const compact = compactText(text);

    if (/^(成交详情|交易详情|交易记录|证券交易|股票交易|买卖记录)$/.test(compact)) {
      activeTable = "trade";
      currentDate = "";
      continue;
    }
    if (compact === "资金进出") {
      activeTable = "cash_flow";
      currentDate = "";
      currentTime = "";
      continue;
    }
    if (compact === "持仓详情") {
      activeTable = "portfolio";
      if (pendingTradeGroup.length > 0) {
        raw.issues.push({
          id: `zunjia-${sourcePdf}-unallocated-trade-fee-${pendingTradeGroup[0].orderId}`,
          severity: "warning",
          title: "尊嘉成交费用未分配",
          detail: `成交 ${pendingTradeGroup.map((trade) => trade.orderId).join("、")} 后没有读取到对应费用汇总，暂按零费用计算，请复核原始月结单。`,
          source: sourcePdf,
        });
        pendingTradeGroup = [];
      }
      pendingPositionName = "";
      pendingPositionValues = null;
      continue;
    }
    if (
      /^(资产概况|利息|重要提示|声明|总计|费用详情|费用|证券进出|新股申购|基金持仓)/.test(compact) &&
      compact !== "持仓详情"
    ) {
      activeTable = "none";
    }

    if (activeTable === "trade") {
      if (/^(港币|港元|美元|人民币|HKD|USD|CNY)(?:交易|成交|买卖)?$/i.test(compact)) {
        currentCurrency = mapCurrency(compact);
      }
      const groupFee = tradeFeeFromLine(line);
      if (groupFee !== null) {
        const groupSide = pendingTradeGroup[0]?.side;
        if (groupSide && pendingTradeGroup.every((trade) => trade.side === groupSide)) {
          supplementalFees[groupSide] = roundMoney(supplementalFees[groupSide] + groupFee.supplemental);
        }
        allocateTradeGroupFee(pendingTradeGroup, groupFee.total);
        pendingTradeGroup = [];
        continue;
      }
      currentDate = normalizeDate(text) || currentDate;
      const trade = parseTradeCandidate(sourcePdf, lines, index, currentDate, currentCurrency, sequence);
      if (trade) {
        raw.trades.push(trade);
        pendingTradeGroup.push(trade);
        sequence += 1;
      }
      continue;
    }

    if (activeTable === "cash_flow") {
      const date = normalizeDate(text);
      if (date) currentDate = date;
      const time = normalizeTime(text);
      if (time) currentTime = time;
      const flow = parseCashFlowLine(sourcePdf, line, currentDate, currentTime, sequence);
      if (flow) {
        raw.cashFlows.push(flow);
        sequence += 1;
        currentTime = "";
      }
      continue;
    }

    if (activeTable === "portfolio") {
      if (/(港币|港元|美元|人民币|HKD|USD|CNY)(?:持仓|持倉)/i.test(compact)) {
        currentCurrency = mapCurrency(compact);
        pendingPositionName = "";
        pendingPositionValues = null;
        continue;
      }
      if (/^(股票|证券|持仓数量|昨收价|收市价|市值|合计|总计)/.test(compact)) continue;

      const security = securityFromText(text, currentCurrency);
      if (security && pendingPositionValues && statementDate) {
        raw.positions.push({
          sourcePdf,
          page: line.page,
          statementDate,
          currency: security.currency,
          market: security.market,
          symbol: security.symbol,
          securityName: normalizeSecurityName(pendingPositionName) || security.symbol,
          quantity: pendingPositionValues.quantity,
          closingPrice: pendingPositionValues.closingPrice,
          marketValue: pendingPositionValues.marketValue,
        });
        pendingPositionName = "";
        pendingPositionValues = null;
        continue;
      }

      const values = positionValuesFromLine(line);
      if (values) {
        pendingPositionValues = values;
        continue;
      }

      if (line.tokens.some((token) => token.x < 300) && !numericTokens(line).length) {
        pendingPositionName = canonicalText(lineCell(line, 0, 300));
      }
    }
  }

  if (raw.statementDetected && !statementDate) {
    raw.issues.push({
      id: `zunjia-${sourcePdf}-missing-statement-date`,
      severity: "blocking",
      title: "未识别尊嘉月结单日期",
      detail: "无法读取月结单日期，交易和期末持仓不能安全归入纳税年度。",
      source: sourcePdf,
    });
  }

  const reported = statementTradeSummary(lines);
  const parsedBuyGross = roundMoney(raw.trades.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + trade.grossAmount, 0));
  const parsedBuyFee = roundMoney(raw.trades.filter((trade) => trade.side === "buy").reduce((sum, trade) => sum + trade.fee, 0));
  const parsedSellGross = roundMoney(raw.trades.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + trade.grossAmount, 0));
  const parsedSellFee = roundMoney(raw.trades.filter((trade) => trade.side === "sell").reduce((sum, trade) => sum + trade.fee, 0));
  const hasBuyTrades = raw.trades.some((trade) => trade.side === "buy");
  const hasSellTrades = raw.trades.some((trade) => trade.side === "sell");
  const alternateBuyGross = hasBuyTrades && !hasSellTrades ? reported.tradeGross : undefined;
  const alternateSellGross = hasSellTrades && !hasBuyTrades ? reported.tradeGross : undefined;
  const alternateBuyFee = hasBuyTrades && !hasSellTrades ? reported.tradeFee : undefined;
  const alternateSellFee = hasSellTrades && !hasBuyTrades ? reported.tradeFee : undefined;
  const comparisons: Array<{
    label: string;
    expected?: number;
    acceptedExpected?: number[];
    actual: number;
    acceptedActuals?: number[];
  }> = [
    { label: "买入总金额", expected: reported.buyGross, acceptedExpected: valuesWithOptional(alternateBuyGross), actual: parsedBuyGross },
    {
      label: "买入总费用及佣金",
      expected: totalFeeIncludingCommission(reported.buyFee, reported.buyCommission),
      acceptedExpected: [...valuesWithOptional(reported.buyFee), ...valuesWithOptional(alternateBuyFee)],
      actual: parsedBuyFee,
      acceptedActuals: [roundMoney(parsedBuyFee - supplementalFees.buy)],
    },
    { label: "卖出总金额", expected: reported.sellGross, acceptedExpected: valuesWithOptional(alternateSellGross), actual: parsedSellGross },
    {
      label: "卖出总费用及佣金",
      expected: totalFeeIncludingCommission(reported.sellFee, reported.sellCommission),
      acceptedExpected: [...valuesWithOptional(reported.sellFee), ...valuesWithOptional(alternateSellFee)],
      actual: parsedSellFee,
      acceptedActuals: [roundMoney(parsedSellFee - supplementalFees.sell)],
    },
  ];
  const mismatches = comparisons.filter(({ expected, acceptedExpected = [], actual, acceptedActuals = [] }) => {
    if (expected === undefined) return false;
    return [expected, ...acceptedExpected].every((reportedValue) =>
      [actual, ...acceptedActuals].every((parsedValue) => Math.abs(reportedValue - parsedValue) > 0.02),
    );
  });
  if (mismatches.length > 0) {
    raw.issues.push({
      id: `zunjia-${sourcePdf}-trade-summary-mismatch`,
      severity: "blocking",
      title: "尊嘉交易汇总核对不一致",
      detail: mismatches
        .map(({ label, expected, actual }) => `${label}月结单为 ${Number(expected).toFixed(2)}，逐笔解析为 ${actual.toFixed(2)}`)
        .join("；"),
      source: sourcePdf,
    });
  }
  return raw;
}

function activityFromTrade(trade: TradeRecord): TradeActivity {
  return {
    id: `zunjia-activity-${trade.date}-${trade.sequence}-${trade.currency}-${trade.symbol}-${trade.side}`,
    broker: ZUNJIA_BROKER,
    date: trade.date,
    time: trade.time,
    sequence: trade.sequence,
    market: trade.market,
    currency: trade.currency,
    symbol: trade.symbol,
    securityName: trade.securityName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: trade.grossAmount,
    fee: trade.fee,
    amount: trade.amount,
    source: trade.sourcePdf,
    note: `成交编号 ${trade.orderId}；尊嘉账户月结单第 ${trade.page} 页`,
  };
}

function openPositionFromRecord(position: PositionRecord): OpenPosition {
  return {
    id: `zunjia-open-${position.statementDate}-${position.currency}-${position.symbol}`,
    broker: ZUNJIA_BROKER,
    asOf: position.statementDate,
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    source: position.sourcePdf,
    note: `尊嘉月末持仓；昨收价 ${position.closingPrice.toFixed(6)}，未实现盈亏不计入资本利得。`,
  };
}

function latestPositions(positions: PositionRecord[]) {
  const latest = new Map<string, PositionRecord>();
  for (const position of positions) {
    const key = `${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementDate.localeCompare(existing.statementDate) >= 0) latest.set(key, position);
  }
  return Array.from(latest.values()).sort((a, b) => a.currency.localeCompare(b.currency) || a.symbol.localeCompare(b.symbol));
}

function dividendSymbol(value: string, currency: Currency) {
  return securityFromText(value, currency)?.symbol ?? "CASH-DIVIDEND";
}

function dividendsFromCashFlows(cashFlows: CashFlowRecord[]): DividendIncome[] {
  const aggregates = new Map<
    string,
    {
      date: string;
      currency: Currency;
      symbol: string;
      grossAmount: number;
      taxWithheld: number;
      fee: number;
      source: string;
      page: number;
      note: string;
    }
  >();

  for (const flow of cashFlows) {
    const description = canonicalText(`${flow.flowType} ${flow.note}`);
    if (!/股息|红利|派息|dividend/i.test(description) && !/预扣税|股息税|withholding tax/i.test(description)) continue;
    const symbol = dividendSymbol(description, flow.currency);
    const key = `${flow.date}::${flow.currency}::${symbol}`;
    const aggregate =
      aggregates.get(key) ??
      ({
        date: flow.date,
        currency: flow.currency,
        symbol,
        grossAmount: 0,
        taxWithheld: 0,
        fee: 0,
        source: flow.sourcePdf,
        page: flow.page,
        note: description,
      } satisfies {
        date: string;
        currency: Currency;
        symbol: string;
        grossAmount: number;
        taxWithheld: number;
        fee: number;
        source: string;
        page: number;
        note: string;
      });
    if (/预扣税|股息税|withholding tax/i.test(description)) {
      aggregate.taxWithheld += Math.abs(flow.amount);
    } else if (/费用|手续费|代收费/i.test(flow.flowType)) {
      aggregate.fee += Math.abs(flow.amount);
    } else if (flow.amount > 0) {
      aggregate.grossAmount += flow.amount;
    }
    aggregates.set(key, aggregate);
  }

  return Array.from(aggregates.values())
    .filter((item) => item.grossAmount > 0)
    .map((item) => ({
      id: `zunjia-dividend-${item.date}-${item.currency}-${item.symbol}`,
      broker: ZUNJIA_BROKER,
      date: item.date,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.symbol === "CASH-DIVIDEND" ? "尊嘉现金股息" : item.symbol,
      grossAmount: roundMoney(item.grossAmount),
      taxWithheld: roundMoney(item.taxWithheld),
      fee: roundMoney(item.fee),
      source: item.source,
      note: item.note,
      evidence: {
        page: item.page,
        text: item.note,
      },
    }));
}

function sortActivities(activities: TradeActivity[]) {
  return [...activities].sort((a, b) => {
    return (
      a.date.localeCompare(b.date) ||
      (a.time ?? "99:99:99").localeCompare(b.time ?? "99:99:99") ||
      (a.sequence ?? 0) - (b.sequence ?? 0)
    );
  });
}

function manualCostMap(manualCosts: ManualCostInput[]) {
  const map = new Map<string, number>();
  for (const item of manualCosts) {
    if (!item.id || !Number.isFinite(item.costBasis) || item.costBasis < 0) continue;
    map.set(item.id, item.costBasis);
  }
  return map;
}

function buildMissingCostRecords(activities: TradeActivity[], targetYear?: number) {
  const quantities = new Map<string, number>();
  const missing: MissingCostRecord[] = [];
  for (const activity of sortActivities(activities)) {
    const key = `${activity.currency}::${activity.symbol}`;
    const trackedQuantity = quantities.get(key) ?? 0;
    if (activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in") {
      quantities.set(key, trackedQuantity + activity.quantity);
      continue;
    }
    if (activity.side !== "sell") continue;
    if (trackedQuantity + 1e-7 >= activity.quantity) {
      quantities.set(key, trackedQuantity - activity.quantity);
      continue;
    }
    quantities.set(key, 0);
    if (targetYear !== undefined && !activity.date.startsWith(String(targetYear))) continue;
    missing.push({
      id: `zunjia-cost-${targetYear ?? "unknown"}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`,
      sellDate: activity.date,
      time: activity.time,
      sequence: activity.sequence,
      market: activity.market,
      currency: activity.currency,
      symbol: activity.symbol,
      securityName: activity.securityName,
      quantity: activity.quantity,
      trackedQuantity,
      proceeds: activity.amount,
      source: activity.source,
    });
  }
  return missing;
}

function buildMissingCostData(
  activities: TradeActivity[],
  targetYear: number | undefined,
  manualCosts: ManualCostInput[],
): { realizedTrades: RealizedTrade[]; requests: CostBasisRequest[]; issues: ReviewIssue[] } {
  const realizedTrades: RealizedTrade[] = [];
  const requests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];
  const costs = manualCostMap(manualCosts);

  for (const item of buildMissingCostRecords(activities, targetYear)) {
    const manualCostBasis = costs.get(item.id);
    if (manualCostBasis !== undefined) {
      realizedTrades.push({
        id: `${item.id}-manual`,
        broker: ZUNJIA_BROKER,
        sellDate: item.sellDate,
        time: item.time,
        sequence: item.sequence,
        market: item.market,
        currency: item.currency,
        symbol: item.symbol,
        securityName: item.securityName,
        quantity: item.quantity,
        proceeds: item.proceeds,
        costBasis: manualCostBasis,
        gainLoss: item.proceeds - manualCostBasis,
        source: item.source,
        note: `用户手动补录这笔卖出总成本：${manualCostBasis}`,
        useBrokerReportedGainLoss: true,
      });
      continue;
    }

    requests.push({
      id: item.id,
      broker: ZUNJIA_BROKER,
      sellDate: item.sellDate,
      time: item.time,
      sequence: item.sequence,
      market: item.market,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.securityName,
      quantity: item.quantity,
      trackedQuantity: item.trackedQuantity,
      proceeds: item.proceeds,
      source: item.source,
      note: "手动补录这笔成本后计入资本利得",
    });
    issues.push({
      id: `${item.id}-cost-gap`,
      severity: "warning",
      title: `${item.symbol} 历史成本缺失`,
      detail: `${item.sellDate} 卖出 ${item.quantity} 股，但上传的尊嘉月结单没有足够的历史买入记录匹配成本。请补充更早月份月结单，或在待补成本中填写这笔卖出的总成本。`,
      source: item.source,
    });
  }
  return { realizedTrades, requests, issues };
}

function aggregateIssue(raw: ZunjiaRawData): ReviewIssue {
  const buys = raw.trades.filter((trade) => trade.side === "buy").length;
  const sells = raw.trades.filter((trade) => trade.side === "sell").length;
  const sources = Array.from(
    new Set([
      ...raw.trades.map((trade) => trade.sourcePdf),
      ...raw.positions.map((position) => position.sourcePdf),
      ...raw.cashFlows.map((flow) => flow.sourcePdf),
    ]),
  );
  return {
    id: `zunjia-${sources.join("-")}-parsed`,
    severity: "info",
    title: "已解析尊嘉账户月结单",
    detail: `已读取 ${sources.length} 份月结单：买入 ${buys} 笔、卖出 ${sells} 笔、资金流水 ${raw.cashFlows.length} 条、月末持仓 ${raw.positions.length} 条。融资利息及普通存取款只用于核对，不会误计为股息或资本利得。`,
    source: sources[0],
  };
}

export async function parseZunjiaPdfs(
  files: ZunjiaFileInput[],
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: ZunjiaRawData = {
    trades: [],
    positions: [],
    cashFlows: [],
    issues: [],
    statementDetected: false,
  };

  for (const [fileIndex, file] of files.entries()) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const fileRaw = parseZunjiaLines(file.name, lines, fileIndex * 100000);
      raw.trades.push(...fileRaw.trades);
      raw.positions.push(...fileRaw.positions);
      raw.cashFlows.push(...fileRaw.cashFlows);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      parsed.issues.push({
        id: `zunjia-${file.name}-pdf-error`,
        severity: "blocking",
        title: "尊嘉 PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  if (!raw.statementDetected) {
    parsed.issues.push({
      id: "zunjia-unsupported-statement",
      severity: "blocking",
      title: "尊嘉文件格式不符合要求",
      detail: "当前没有识别到尊嘉证券国际有限公司的账户月结单特征，请确认券商选择和 PDF 文件。",
      source: files[0]?.name,
    });
    return parsed;
  }

  const activities = sortActivities(raw.trades.map(activityFromTrade));
  const missingCost = buildMissingCostData(activities, options.targetYear, options.manualCosts ?? []);
  parsed.tradeActivities.push(...activities);
  parsed.realizedTrades.push(...missingCost.realizedTrades);
  parsed.dividends.push(...dividendsFromCashFlows(raw.cashFlows));
  parsed.openPositions.push(...latestPositions(raw.positions).map(openPositionFromRecord));
  parsed.costBasisRequests.push(...missingCost.requests);
  parsed.issues.push(...raw.issues, ...missingCost.issues);

  if (raw.trades.length > 0 || raw.positions.length > 0 || raw.cashFlows.length > 0) {
    parsed.issues.push(aggregateIssue(raw));
  } else {
    parsed.issues.push({
      id: "zunjia-empty-statement",
      severity: "info",
      title: "本月没有尊嘉股票交易",
      detail: "已识别为尊嘉账户月结单，但没有读取到股票买卖、资金流水或期末持仓记录。",
      source: files[0]?.name,
    });
  }

  if (raw.trades.length === 0) {
    parsed.issues.push({
      id: "zunjia-no-stock-activity",
      severity: "info",
      title: "本月没有尊嘉股票交易",
      detail: "已识别为尊嘉账户月结单，本月没有股票买卖记录；系统会继续展示期末持仓和可识别分红用于核对。",
      source: files[0]?.name,
    });
  }
  return parsed;
}
