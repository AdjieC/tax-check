import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { normalizeSymbol } from "./common";
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

interface ChiefFileInput {
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
  ref: string;
  side: "buy" | "sell";
  market: string;
  currency: Currency;
  tradeDate: string;
  settleDate: string;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  amount: number;
}

interface IpoAllocationRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  ref: string;
  market: string;
  currency: Currency;
  date: string;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  fee: number;
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  currency: Currency;
  date: string;
  ref: string;
  category: string;
  note: string;
  amount: number;
}

interface StockMoveRecord {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  date: string;
  symbol: string;
  securityName: string;
  category: string;
  note: string;
  quantity: number;
}

interface PositionRecord {
  sourcePdf: string;
  page: number;
  statementDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  openingQty: number;
  movementQty: number;
  closingQty: number;
  closingPrice: number;
  marketValue: number;
  marginRate: number;
  marginValue: number;
  averageCost: number;
  lastTradeDate: string;
}

interface ChiefRawData {
  trades: TradeRecord[];
  ipoAllocations: IpoAllocationRecord[];
  cashFlows: CashFlowRecord[];
  stockMoves: StockMoveRecord[];
  positions: PositionRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface MissingCostRecord {
  id: string;
  sellDate: string;
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

const CHIEF_BROKER = "致富";

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("證", "证")
    .replaceAll("券", "券")
    .replaceAll("戶", "户")
    .replaceAll("賬", "账")
    .replaceAll("帳", "账")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("餘", "余")
    .replaceAll("馀", "余")
    .replaceAll("認", "认")
    .replaceAll("購", "购")
    .replaceAll("獲", "获")
    .replaceAll("總", "总")
    .replaceAll("額", "额")
    .replaceAll("幣", "币")
    .replaceAll("倉", "仓")
    .replaceAll("價", "价")
    .replaceAll("數", "数")
    .replaceAll("−", "-");
}

function compactText(value: string) {
  return canonicalText(value).replace(/\s+/g, "");
}

function parseNumber(value: string) {
  const text = canonicalText(value).replace(/,/g, "").replace(/[()]/g, "").replace(/[^0-9.+-]/g, "").trim();
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseAmount(value: string) {
  const text = canonicalText(value);
  const negative = /^\(.*\)$/.test(text.trim()) || text.trim().startsWith("-");
  const parsed = parseNumber(text);
  return negative ? -Math.abs(parsed) : parsed;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("CNH") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function marketName(currency: Currency) {
  if (currency === "USD") return "美国市场";
  if (currency === "CNY") return "A股通";
  return "香港市场";
}

function normalizeDate(value: string) {
  const text = canonicalText(value);
  const slash = text.match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
  if (slash) return `${slash[3]}-${slash[2]}-${slash[1]}`;
  const dash = text.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (dash) return `${dash[1]}-${dash[2]}-${dash[3]}`;
  return "";
}

function normalizeSecurityItem(value: string) {
  return canonicalText(value)
    .replace(/\s+([）)])/g, "$1")
    .replace(/([（(])\s+/g, "$1")
    .replace(/\s+([@#])/g, "$1")
    .replace(/([^\x00-\x7F])\s+([^\x00-\x7F])/g, "$1$2")
    .replace(/([A-Za-z])\s+([^\x00-\x7F])/g, "$1$2")
    .replace(/([^\x00-\x7F])\s+([A-Za-z0-9#(])/g, "$1$2")
    .trim();
}

function normalizeChiefSymbol(value: string) {
  const text = canonicalText(value).replace(/^#/, "").replace(/[()（）]/g, "").trim().toUpperCase();
  return /^\d+$/.test(text) ? normalizeSymbol(text) : text;
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

function rightmostNumber(line: TextLine) {
  for (let index = line.tokens.length - 1; index >= 0; index -= 1) {
    const text = canonicalText(line.tokens[index].text);
    if (/^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/.test(text)) return text;
  }
  return "";
}

function lineDate(line: TextLine) {
  return normalizeDate(lineCell(line, 20, 74));
}

function lineStartsWithDate(line: TextLine) {
  return Boolean(lineDate(line));
}

function parsePrice(value: string) {
  const match = canonicalText(value).match(/@([+-]?\d[\d,]*(?:\.\d+)?)/);
  return match ? parseNumber(match[1]) : 0;
}

function parseStatementDate(text: string) {
  const match = canonicalText(text).match(/结单日期\s*:\s*(\d{2}\/\d{2}\/20\d{2})/);
  return match ? normalizeDate(match[1]) : "";
}

function securityFromTradeNote(note: string) {
  const normalized = normalizeSecurityItem(note).replace(/^(?:买\s*入|卖\s*出)\s*/u, "");
  const symbolMatch = normalized.match(/[（(]\s*#?\s*([A-Z]{0,3}\d{3,12}|[A-Z]{1,12}[A-Z0-9]*)\s*[）)]/i);
  if (!symbolMatch || symbolMatch.index === undefined) return null;

  const quantityMatch = normalized
    .slice(symbolMatch.index + symbolMatch[0].length)
    .match(/([+-]?\d[\d,]*(?:\.\d+)?)\s*股/);
  if (!quantityMatch) return null;

  const symbol = normalizeChiefSymbol(symbolMatch[1]);
  const securityName = clean(normalized.slice(0, symbolMatch.index).replace(/^(?:买\s*入|卖\s*出)\s*/u, "")) || symbol;
  return {
    symbol,
    securityName,
    quantity: Math.abs(parseNumber(quantityMatch[1])),
  };
}

function securityNameFromRefundNote(note: string, symbol: string) {
  const normalized = normalizeSecurityItem(note);
  const match = normalized.match(/[（(]\s*#?\s*([A-Z]{0,3}\d{3,12}|[A-Z]{1,12}[A-Z0-9]*)\s*[）)]/i);
  if (!match || match.index === undefined) return symbol;
  return clean(normalized.slice(0, match.index).replace(/的退款$/, "")) || symbol;
}

async function extractPdfLines(fileName: string, data: ArrayBuffer, password?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    disableFontFace: true,
    disableWorker: typeof window === "undefined",
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  const pages: TextLine[][] = [];

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

    pages.push(
      groups
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
  }

  if (pages.length === 0) {
    throw new Error(`${fileName} 没有可解析页面`);
  }

  return pages.flat();
}

function parseCashFlowLine(sourcePdf: string, line: TextLine, currency: Currency): CashFlowRecord | null {
  const date = lineDate(line);
  const ref = lineCell(line, 115, 170);
  const category = canonicalText(lineCell(line, 170, 214));
  const note = canonicalText(lineCell(line, 214, 447));
  const amountText = lineCell(line, 447, 510);
  if (!date || !ref || !category || !note || !/[0-9]/.test(amountText)) return null;

  return {
    sourcePdf,
    page: line.page,
    currency,
    date,
    ref,
    category,
    note,
    amount: parseAmount(amountText),
  };
}

function parseCashTradeLine(
  sourcePdf: string,
  lines: TextLine[],
  index: number,
  currency: Currency,
  sequence: number,
): TradeRecord | null {
  const line = lines[index];
  const tradeDate = lineDate(line);
  const settleDate = normalizeDate(lineCell(line, 74, 120));
  const ref = lineCell(line, 115, 170);
  const category = compactText(lineCell(line, 170, 214));
  if (!tradeDate || !settleDate || !ref) return null;
  if (!category.includes("买入") && !category.includes("卖出")) return null;

  const note = lineCell(line, 214, 447);
  const security = securityFromTradeNote(note);
  if (!security || security.quantity <= 0) return null;

  let unitPrice = parsePrice(note);
  for (let cursor = index + 1; cursor < lines.length && cursor <= index + 3 && !unitPrice; cursor += 1) {
    if (lineStartsWithDate(lines[cursor])) break;
    unitPrice = parsePrice(lines[cursor].text);
  }
  if (!unitPrice) unitPrice = Math.abs(parseAmount(lineCell(line, 447, 510))) / security.quantity;

  const amount = Math.abs(parseAmount(lineCell(line, 447, 510)));
  const side = category.includes("卖出") ? "sell" : "buy";
  return {
    sourcePdf,
    page: line.page,
    sequence,
    ref,
    side,
    market: marketName(currency),
    currency,
    tradeDate,
    settleDate,
    symbol: security.symbol,
    securityName: security.securityName,
    quantity: security.quantity,
    unitPrice,
    grossAmount: roundMoney(security.quantity * unitPrice),
    amount,
  };
}

function parseIpoSubscriptionFee(lines: TextLine[], index: number) {
  const line = lines[index];
  const ref = lineCell(line, 115, 170);
  const category = compactText(lineCell(line, 170, 214));
  const note = compactText(lineCell(line, 214, 447));
  if (!ref || !category.includes("提取") || !note.includes("认购")) return null;

  let fee = 0;
  for (let cursor = index + 1; cursor < lines.length && cursor <= index + 4; cursor += 1) {
    const candidate = lines[cursor];
    if (lineStartsWithDate(candidate)) break;
    const text = compactText(candidate.text);
    if (text.includes("手续费")) fee += Math.abs(parseAmount(rightmostNumber(candidate)));
  }
  return fee > 0 ? { ref, fee } : null;
}

function parseIpoAllocationLine(
  sourcePdf: string,
  lines: TextLine[],
  index: number,
  currency: Currency,
  sequence: number,
  ipoFeesByRef: Map<string, number>,
): IpoAllocationRecord | null {
  const line = lines[index];
  const date = lineDate(line);
  const ref = lineCell(line, 115, 170);
  const category = compactText(lineCell(line, 170, 214));
  const note = lineCell(line, 214, 447);
  if (!date || !ref || !category.includes("存入") || !compactText(note).includes("退款")) return null;

  for (let cursor = index + 1; cursor < lines.length && cursor <= index + 3; cursor += 1) {
    const candidate = lines[cursor];
    if (lineStartsWithDate(candidate)) break;
    const text = canonicalText(candidate.text);
    const match = text.match(/获分配\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*[（(]\s*#?([A-Z]{0,3}\d{3,12})\s*[）)]\s*@\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*总额\s*\$?\s*([+-]?\d[\d,]*(?:\.\d+)?)/i);
    if (!match) continue;

    const quantity = Math.abs(parseNumber(match[1]));
    if (quantity <= 0) return null;

    const symbol = normalizeChiefSymbol(match[2]);
    const fee = ipoFeesByRef.get(ref) ?? 0;
    return {
      sourcePdf,
      page: line.page,
      sequence,
      ref,
      market: marketName(currency),
      currency,
      date,
      symbol,
      securityName: securityNameFromRefundNote(note, symbol),
      quantity,
      unitPrice: parseNumber(match[3]),
      amount: roundMoney(parseNumber(match[4]) + fee),
      fee,
    };
  }

  return null;
}

function parseStockMoveLine(sourcePdf: string, line: TextLine, currency: Currency): StockMoveRecord | null {
  const date = lineDate(line);
  const rawSymbol = lineCell(line, 74, 133);
  const category = canonicalText(lineCell(line, 216, 290));
  const note = canonicalText(lineCell(line, 290, 535));
  const quantityText = lineCell(line, 535, 590);
  if (!date || !rawSymbol || !category || !/[0-9]/.test(quantityText)) return null;

  const symbol = normalizeChiefSymbol(rawSymbol);
  const securityName = normalizeSecurityItem(lineCell(line, 133, 216)) || symbol;
  return {
    sourcePdf,
    page: line.page,
    market: marketName(currency),
    currency,
    date,
    symbol,
    securityName,
    category,
    note,
    quantity: parseAmount(quantityText),
  };
}

function isPortfolioContinuationLine(line: TextLine) {
  if (line.tokens.length === 0) return false;
  if (line.tokens.some((token) => token.x >= 170)) return false;
  const text = compactText(line.text);
  if (!text || lineStartsWithDate(line)) return false;
  if (text.includes("总货值") || text.includes("注意事项")) return false;
  return true;
}

function parsePositionLine(
  sourcePdf: string,
  lines: TextLine[],
  index: number,
  statementDate: string,
  currency: Currency,
): PositionRecord | null {
  const line = lines[index];
  const symbol = normalizeChiefSymbol(lineCell(line, 20, 58));
  if (!symbol || symbol === "证券代号" || !/^[A-Z0-9]{3,}$/.test(symbol)) return null;

  const openingQty = lineCell(line, 160, 215);
  const movementQty = lineCell(line, 215, 260);
  const closingQty = lineCell(line, 260, 285);
  const closingPrice = lineCell(line, 285, 340);
  const marketValue = lineCell(line, 335, 385);
  const marginRate = lineCell(line, 385, 420);
  const marginValue = lineCell(line, 420, 465);
  const averageCost = lineCell(line, 465, 505);
  const lastTradeDate = normalizeDate(lineCell(line, 505, 590));

  if (![openingQty, movementQty, closingQty, closingPrice, marketValue].every((value) => /[0-9]/.test(value))) {
    return null;
  }

  let securityName = normalizeSecurityItem(lineCell(line, 58, 170));
  for (let cursor = index + 1; cursor < lines.length && cursor <= index + 2; cursor += 1) {
    if (!isPortfolioContinuationLine(lines[cursor])) break;
    securityName = clean(`${securityName}${normalizeSecurityItem(lines[cursor].text)}`);
  }

  return {
    sourcePdf,
    page: line.page,
    statementDate,
    market: marketName(currency),
    currency,
    symbol,
    securityName: securityName || symbol,
    openingQty: parseNumber(openingQty),
    movementQty: parseNumber(movementQty),
    closingQty: parseNumber(closingQty),
    closingPrice: parseNumber(closingPrice),
    marketValue: parseNumber(marketValue),
    marginRate: parseNumber(marginRate),
    marginValue: parseNumber(marginValue),
    averageCost: parseNumber(averageCost),
    lastTradeDate,
  };
}

function isChiefStatement(text: string) {
  const canonical = canonicalText(text);
  const lower = canonical.toLowerCase();
  return canonical.includes("致富证券") || lower.includes("chief securities") || lower.includes("chiefgroup.com.hk");
}

function parseChiefLines(sourcePdf: string, lines: TextLine[]): ChiefRawData {
  const raw: ChiefRawData = {
    trades: [],
    ipoAllocations: [],
    cashFlows: [],
    stockMoves: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };

  let activeTable: "none" | "cash_flow" | "stock_move" | "portfolio" = "none";
  let statementDate = "";
  let activeCurrency: Currency = "HKD";
  let sequence = 0;
  const ipoFeesByRef = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = canonicalText(line.text);
    const compact = compactText(text);

    if (isChiefStatement(text)) raw.statementDetected = true;
    statementDate = statementDate || parseStatementDate(text);

    if (compact.includes("本月资金提存及买卖记录")) {
      activeTable = "cash_flow";
      activeCurrency = mapCurrency(text);
      continue;
    }
    if (compact.includes("证券提存")) {
      activeTable = "stock_move";
      activeCurrency = mapCurrency(text);
      continue;
    }
    if (compact.includes("投资组合") && compact.includes("(HKD)")) {
      activeTable = "portfolio";
      activeCurrency = mapCurrency(text);
      continue;
    }
    if (compact.includes("注意事项") || compact.includes("重要提示") || compact.includes("户口结余摘要")) {
      activeTable = "none";
      continue;
    }

    if (activeTable === "cash_flow") {
      const flow = parseCashFlowLine(sourcePdf, line, activeCurrency);
      if (flow) raw.cashFlows.push(flow);

      const ipoFee = parseIpoSubscriptionFee(lines, index);
      if (ipoFee) ipoFeesByRef.set(ipoFee.ref, ipoFee.fee);

      const trade = parseCashTradeLine(sourcePdf, lines, index, activeCurrency, sequence);
      if (trade) {
        raw.trades.push(trade);
        sequence += 1;
      }

      const allocation = parseIpoAllocationLine(sourcePdf, lines, index, activeCurrency, sequence, ipoFeesByRef);
      if (allocation) {
        raw.ipoAllocations.push(allocation);
        sequence += 1;
      }
      continue;
    }

    if (activeTable === "stock_move") {
      const move = parseStockMoveLine(sourcePdf, line, activeCurrency);
      if (move) raw.stockMoves.push(move);
      continue;
    }

    if (activeTable === "portfolio") {
      if (compact.includes("证券代号") || compact.includes("总货值")) continue;
      const position = parsePositionLine(sourcePdf, lines, index, statementDate, activeCurrency);
      if (position) raw.positions.push(position);
    }
  }

  return raw;
}

function tradeActivityFromTrade(trade: TradeRecord): TradeActivity {
  return {
    id: `chief-activity-${trade.tradeDate}-${trade.sequence}-${trade.currency}-${trade.symbol}-${trade.side}`,
    broker: CHIEF_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: trade.market,
    currency: trade.currency,
    symbol: trade.symbol,
    securityName: trade.securityName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: trade.grossAmount,
    fee: roundMoney(Math.abs(trade.amount - Math.abs(trade.grossAmount))),
    amount: trade.amount,
    source: "本月资金提存及买卖记录",
    note: `交易编号 ${trade.ref}；交收日 ${trade.settleDate}；${trade.sourcePdf} 第 ${trade.page} 页`,
  };
}

function tradeActivityFromIpoAllocation(allocation: IpoAllocationRecord): TradeActivity {
  return {
    id: `chief-ipo-${allocation.date}-${allocation.sequence}-${allocation.currency}-${allocation.symbol}`,
    broker: CHIEF_BROKER,
    date: allocation.date,
    sequence: allocation.sequence,
    market: allocation.market,
    currency: allocation.currency,
    symbol: allocation.symbol,
    securityName: allocation.securityName,
    side: "acquire",
    quantity: allocation.quantity,
    unitPrice: allocation.unitPrice,
    grossAmount: roundMoney(allocation.quantity * allocation.unitPrice),
    fee: allocation.fee,
    amount: allocation.amount,
    source: "新股获分配",
    note: `交易编号 ${allocation.ref}；获分配新股，总额${allocation.fee ? "含认购手续费" : ""}；${allocation.sourcePdf} 第 ${allocation.page} 页`,
  };
}

function stockMoveActivity(move: StockMoveRecord, index: number): TradeActivity {
  return {
    id: `chief-stock-move-${move.date}-${index}-${move.currency}-${move.symbol}-${move.quantity}`,
    broker: CHIEF_BROKER,
    date: move.date,
    sequence: 10_000 + index,
    market: move.market,
    currency: move.currency,
    symbol: move.symbol,
    securityName: move.securityName,
    side: move.quantity >= 0 ? "transfer_in" : "transfer_out",
    quantity: Math.abs(move.quantity),
    amount: 0,
    source: "证券提存",
    note: `${move.category}；${move.note}；证券提存记录仅用于核对，未携带原始成本，已排除税务成本重放。`,
    excludedFromTaxReplay: true,
  };
}

function activityKey(activity: Pick<TradeActivity, "currency" | "symbol">) {
  return `${activity.currency}::${activity.symbol}`;
}

function sortActivities(activities: TradeActivity[]) {
  const rank: Record<TradeActivity["side"], number> = {
    acquire: 1,
    transfer_in: 1,
    stock_split: 1.5,
    buy: 2,
    long_open: 2,
    short_open: 2,
    short_close: 2,
    sell: 2,
    transfer_out: 3,
  };
  return [...activities].sort((a, b) => {
    return a.date.localeCompare(b.date) || rank[a.side] - rank[b.side] || (a.sequence ?? 0) - (b.sequence ?? 0);
  });
}

function manualCostMap(manualCosts: ManualCostInput[] = []) {
  const costs = new Map<string, number>();
  for (const item of manualCosts) {
    if (!item.id) continue;
    if (!Number.isFinite(item.costBasis) || item.costBasis < 0) continue;
    costs.set(item.id, item.costBasis);
  }
  return costs;
}

function buildMissingCostRequests(activities: TradeActivity[], targetYear?: number): MissingCostRecord[] {
  const quantities = new Map<string, number>();
  const missing: MissingCostRecord[] = [];

  for (const activity of sortActivities(activities).filter((item) => !item.excludedFromTaxReplay)) {
    const key = activityKey(activity);
    const quantity = quantities.get(key) ?? 0;
    if (activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in") {
      quantities.set(key, quantity + activity.quantity);
      continue;
    }
    if (activity.side === "sell") {
      if (quantity + 1e-7 < activity.quantity) {
        if (targetYear === undefined || activity.date.startsWith(String(targetYear))) {
          missing.push({
            id: `chief-cost-${targetYear ?? "unknown"}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`,
            sellDate: activity.date,
            sequence: activity.sequence,
            market: activity.market,
            currency: activity.currency,
            symbol: activity.symbol,
            securityName: activity.securityName,
            quantity: activity.quantity,
            trackedQuantity: quantity,
            proceeds: activity.amount,
            source: activity.source,
          });
        }
        quantities.set(key, 0);
      } else {
        quantities.set(key, quantity - activity.quantity);
      }
      continue;
    }
    quantities.set(key, Math.max(0, quantity - activity.quantity));
  }

  return missing;
}

function buildTradeActivities(
  raw: ChiefRawData,
  targetYear?: number,
  manualCosts: ManualCostInput[] = [],
): { activities: TradeActivity[]; realizedTrades: RealizedTrade[]; costBasisRequests: CostBasisRequest[]; issues: ReviewIssue[] } {
  const allocationKeys = new Set(
    raw.ipoAllocations.map((item) => `${item.date}::${item.currency}::${item.symbol}::${roundMoney(item.quantity)}`),
  );
  const stockMoveActivities = raw.stockMoves
    .filter((move) => !allocationKeys.has(`${move.date}::${move.currency}::${move.symbol}::${roundMoney(Math.abs(move.quantity))}`))
    .map(stockMoveActivity);
  const activities = [
    ...raw.trades.map(tradeActivityFromTrade),
    ...raw.ipoAllocations.map(tradeActivityFromIpoAllocation),
    ...stockMoveActivities,
  ];
  const missing = buildMissingCostRequests(activities, targetYear);
  const manualCostsById = manualCostMap(manualCosts);
  const realizedTrades: RealizedTrade[] = [];
  const costBasisRequests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];

  for (const item of missing) {
    const manualCost = manualCostsById.get(item.id);
    if (manualCost !== undefined) {
      realizedTrades.push({
        id: `${item.id}-manual`,
        broker: CHIEF_BROKER,
        sellDate: item.sellDate,
        sequence: item.sequence,
        market: item.market,
        currency: item.currency,
        symbol: item.symbol,
        securityName: item.securityName,
        quantity: item.quantity,
        proceeds: item.proceeds,
        costBasis: manualCost,
        gainLoss: item.proceeds - manualCost,
        source: item.source,
        note: `用户手动补录这笔卖出总成本：${manualCost}`,
        useBrokerReportedGainLoss: true,
      });
      continue;
    }

    costBasisRequests.push({
      id: item.id,
      broker: CHIEF_BROKER,
      sellDate: item.sellDate,
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
      detail: `${item.sellDate} 卖出 ${item.quantity} 股/份，但上传的致富月结单没有足够的买入或获分配记录匹配成本。请补充更早月份月结单，或在待补成本中手动填写这笔成本。`,
      source: item.source,
    });
  }

  return {
    activities: sortActivities(activities),
    realizedTrades,
    costBasisRequests,
    issues,
  };
}

function buildOpenPositions(raw: ChiefRawData): OpenPosition[] {
  const latest = new Map<string, PositionRecord>();
  for (const position of raw.positions) {
    if (position.closingQty <= 0) continue;
    const key = `${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementDate > existing.statementDate) latest.set(key, position);
  }

  return Array.from(latest.values()).map((position) => {
    const costBasis = position.averageCost > 0 ? roundMoney(position.averageCost * position.closingQty) : undefined;
    return {
      id: `chief-open-${position.statementDate}-${position.currency}-${position.symbol}`,
      broker: CHIEF_BROKER,
      asOf: position.statementDate,
      market: position.market,
      currency: position.currency,
      symbol: position.symbol,
      securityName: position.securityName,
      quantity: position.closingQty,
      marketValue: position.marketValue,
      costBasis,
      unrealizedGainLoss: costBasis !== undefined ? roundMoney(position.marketValue - costBasis) : undefined,
      source: position.sourcePdf,
      note: `平均买入价 ${position.averageCost || "-"}；最后交易日 ${position.lastTradeDate || "-"}`,
    } satisfies OpenPosition;
  });
}

function dividendSymbolFromNote(note: string) {
  const canonical = canonicalText(note);
  const hk = canonical.match(/[（(]\s*#?(\d{3,5})\s*[）)]/);
  if (hk) return normalizeSymbol(hk[1]);
  return canonical.match(/\b([A-Z]{1,6})(?:\.US)?\b/i)?.[1].toUpperCase() ?? null;
}

function buildDividends(cashFlows: CashFlowRecord[]): DividendIncome[] {
  const aggregates = new Map<
    string,
    {
      date: string;
      currency: Currency;
      symbol: string;
      securityName: string;
      grossAmount: number;
      taxWithheld: number;
      fee: number;
      source: string;
      note: string;
    }
  >();

  for (const cashFlow of cashFlows) {
    const note = canonicalText(cashFlow.note);
    const category = canonicalText(cashFlow.category);
    const isInterest = note.includes("利息") && cashFlow.amount > 0;
    const isDividend = note.includes("股息") || note.includes("红利") || category.includes("股息") || category.includes("红利");
    if (!isInterest && !isDividend) continue;

    const symbol = isInterest ? "CASH-INTEREST" : dividendSymbolFromNote(note);
    if (!symbol) continue;
    const key = `${cashFlow.date}-${cashFlow.currency}-${symbol}`;
    const aggregate =
      aggregates.get(key) ??
      ({
        date: cashFlow.date,
        currency: cashFlow.currency,
        symbol,
        securityName: isInterest ? "现金利息" : symbol,
        grossAmount: 0,
        taxWithheld: 0,
        fee: 0,
        source: cashFlow.sourcePdf,
        note,
      } satisfies {
        date: string;
        currency: Currency;
        symbol: string;
        securityName: string;
        grossAmount: number;
        taxWithheld: number;
        fee: number;
        source: string;
        note: string;
      });

    if (cashFlow.amount > 0) {
      aggregate.grossAmount += cashFlow.amount;
      aggregate.note = note || aggregate.note;
    } else if (cashFlow.amount < 0 && note.includes("税")) {
      aggregate.taxWithheld += Math.abs(cashFlow.amount);
    } else if (cashFlow.amount < 0 && (note.includes("手续费") || note.includes("收费"))) {
      aggregate.fee += Math.abs(cashFlow.amount);
    }

    aggregates.set(key, aggregate);
  }

  return Array.from(aggregates.values())
    .filter((item) => item.grossAmount > 0)
    .map((item) => ({
      id: `chief-dividend-${item.date}-${item.currency}-${item.symbol}`,
      broker: CHIEF_BROKER,
      date: item.date,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.securityName,
      grossAmount: roundMoney(item.grossAmount),
      taxWithheld: roundMoney(item.taxWithheld),
      fee: roundMoney(item.fee),
      source: item.source,
      note: item.symbol === "CASH-INTEREST" ? "致富现金利息，按利息/股息类收入列示。" : item.note,
    }));
}

function moneyText(value: number, currency: Currency) {
  return `${currency} ${roundMoney(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function aggregateIssue(raw: ChiefRawData): ReviewIssue {
  const sources = Array.from(
    new Set([
      ...raw.trades.map((trade) => trade.sourcePdf),
      ...raw.ipoAllocations.map((allocation) => allocation.sourcePdf),
      ...raw.positions.map((position) => position.sourcePdf),
    ]),
  );
  const buys = raw.trades.filter((trade) => trade.side === "buy");
  const sells = raw.trades.filter((trade) => trade.side === "sell");
  const sellTotalByCurrency = sells.reduce((totals, trade) => {
    totals.set(trade.currency, (totals.get(trade.currency) ?? 0) + trade.amount);
    return totals;
  }, new Map<Currency, number>());
  const proceedsText = Array.from(sellTotalByCurrency.entries())
    .map(([currency, amount]) => moneyText(amount, currency))
    .join("、");

  return {
    id: `chief-${sources.length}-files-parsed`,
    severity: "info",
    title: "已解析致富月结单",
    detail: `已读取 ${sources.length} 份致富月结单：买入 ${buys.length} 笔、卖出 ${sells.length} 笔${proceedsText ? `，卖出收入 ${proceedsText}` : ""}，新股获分配 ${raw.ipoAllocations.length} 笔，证券提存 ${raw.stockMoves.length} 条，期末持仓 ${raw.positions.length} 条。系统会按成交日期重放成本，持仓和未卖出记录不参与本期已实现盈亏。`,
    source: sources[0],
  };
}

export async function parseChiefPdfs(
  files: ChiefFileInput[],
  password?: string,
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: ChiefRawData = {
    trades: [],
    ipoAllocations: [],
    cashFlows: [],
    stockMoves: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data, password);
      const fileRaw = parseChiefLines(file.name, lines);
      raw.trades.push(...fileRaw.trades);
      raw.ipoAllocations.push(...fileRaw.ipoAllocations);
      raw.cashFlows.push(...fileRaw.cashFlows);
      raw.stockMoves.push(...fileRaw.stockMoves);
      raw.positions.push(...fileRaw.positions);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      raw.issues.push({
        id: `chief-${file.name}-pdf-error`,
        severity: "blocking",
        title: "致富PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。请确认文件是否完整，若 PDF 加密请填写密码。",
        source: file.name,
      });
    }
  }

  const activities = buildTradeActivities(raw, options.targetYear, options.manualCosts ?? []);
  parsed.tradeActivities.push(...activities.activities);
  parsed.realizedTrades.push(...activities.realizedTrades);
  parsed.openPositions.push(...buildOpenPositions(raw));
  parsed.dividends.push(...buildDividends(raw.cashFlows));
  parsed.costBasisRequests.push(...activities.costBasisRequests);
  parsed.issues.push(...raw.issues, ...activities.issues);

  const hasParsedRows =
    raw.trades.length > 0 ||
    raw.ipoAllocations.length > 0 ||
    raw.cashFlows.length > 0 ||
    raw.stockMoves.length > 0 ||
    raw.positions.length > 0;
  if (hasParsedRows) {
    parsed.issues.push(aggregateIssue(raw));
  } else if (!raw.statementDetected && files.length > 0) {
    parsed.issues.push({
      id: "chief-invalid-format",
      severity: "blocking",
      title: "致富文件格式不符合要求",
      detail: "当前文件没有识别到致富证券月结单的资金提存及买卖记录、证券提存或投资组合，请确认上传的是致富证券 PDF 月结单。",
    });
  } else if (raw.trades.length === 0 && raw.ipoAllocations.length === 0) {
    parsed.issues.push({
      id: "chief-no-stock-activity",
      severity: "info",
      title: "本月没有致富股票交易",
      detail: "已识别为致富月结单，但没有读取到股票买卖或新股获分配记录。系统会继续读取现金流水和期末持仓用于核对。",
    });
  }

  return parsed;
}
