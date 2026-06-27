import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
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

interface ZirconFileInput {
  name: string;
  data: ArrayBuffer;
}

interface ManualCostInput {
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

interface PositionRecord {
  sourcePdf: string;
  page: number;
  statementMonth: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  openingQty: number;
  movementQty: number;
  closingQty: number;
  costPrice: number;
  closingPrice: number;
  marketValue: number;
}

interface TradeRecord {
  product: "stock" | "fund";
  sourcePdf: string;
  page: number;
  side: "buy" | "sell";
  rawSide: string;
  market: string;
  currency: Currency;
  tradeDate: string;
  settleDate: string;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  clearingBalance: number;
  sequence: number;
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  currency: Currency;
  date: string;
  ref: string;
  note: string;
  amount: number;
}

interface StockMoveRecord {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  date: string;
  ref: string;
  note: string;
  symbol: string;
  securityName: string;
  quantity: number;
}

interface ZirconRawData {
  trades: TradeRecord[];
  positions: PositionRecord[];
  cashFlows: CashFlowRecord[];
  stockMoves: StockMoveRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface MissingCostAggregate {
  id: string;
  sellDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  proceeds: number;
  source: string;
  sequence?: number;
}

const ZIRCON_BROKER = "卓锐";
const DATE_RE = /^20\d{2}-\d{2}-\d{2}$/;
const MONTH_RE = /^20\d{2}-\d{2}$/;

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return value
    .normalize("NFKC")
    .replaceAll("⼊", "入")
    .replaceAll("⽉", "月")
    .replaceAll("⽇", "日")
    .replaceAll("⼾", "户")
    .replaceAll("⾦", "金")
    .replaceAll("⾼", "高")
    .replaceAll("⼩", "小")
    .replaceAll("⼿", "手")
    .replaceAll("⾹", "香")
    .replaceAll("⾏", "行")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("贖", "赎")
    .replaceAll("證", "证")
    .replaceAll("券", "券")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("戶", "户")
    .replaceAll("資", "资")
    .replaceAll("額", "额")
    .replaceAll("發", "发")
    .replaceAll("幣", "币")
    .replaceAll("種", "种")
    .replaceAll("數", "数")
    .replaceAll("價", "价")
    .replaceAll("−", "-");
}

function parseNumber(value: string) {
  const parsed = Number(canonicalText(value).replace(/,/g, "").replace(/[()]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasNumber(value: string) {
  return /[+-]?\d/.test(canonicalText(value).replace(/,/g, ""));
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("CNH") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function normalizeSymbol(value: string) {
  const text = canonicalText(value).replace(/[()（）]/g, "").trim().toUpperCase();
  if (/^\d{3,5}$/.test(text)) return text.padStart(5, "0");
  return text;
}

function splitSecurity(value: string) {
  const text = clean(canonicalText(value));
  const [rawSymbol = "", ...nameParts] = text.split(" ");
  const symbol = normalizeSymbol(rawSymbol);
  return {
    symbol,
    securityName: clean(nameParts.join(" ")) || symbol,
  };
}

function marketFromExchange(value: string, currency: Currency) {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("US") || text.includes("NASDAQ") || text.includes("NYSE") || text.includes("AMEX")) return "美国市场";
  if (text.includes("MUTUAL FUND")) return currency === "USD" ? "美元基金" : "香港基金";
  return "香港市场";
}

function parseMarketGroup(value: string): { market: string; currency: Currency } | null {
  const text = clean(canonicalText(value));
  const match = text.match(/^([A-Z]{2})-(.+)-([A-Z]{3})$/);
  if (!match) return null;
  const currency = mapCurrency(match[3]);
  return {
    market: marketFromExchange(`${match[1]}/${match[2]}`, currency),
    currency,
  };
}

function parseStatementMonthFromFileName(fileName: string) {
  const match = fileName.match(/(20\d{2})[-_年.]?(0[1-9]|1[0-2])/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

async function extractPdfLines(fileName: string, data: ArrayBuffer, password?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    disableFontFace: true,
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

function parsePositionLine(
  sourcePdf: string,
  line: TextLine,
  statementMonth: string,
  market: string,
  currency: Currency,
): PositionRecord | null {
  const item = lineCell(line, 0, 230);
  const canonicalItem = canonicalText(item);
  if (
    !item ||
    canonicalItem.startsWith("股票代号") ||
    canonicalItem.startsWith("Stock Code") ||
    canonicalItem.startsWith("合计") ||
    parseMarketGroup(canonicalItem)
  ) {
    return null;
  }

  const openingQty = lineCell(line, 230, 285);
  const movementQty = lineCell(line, 285, 345);
  const closingQty = lineCell(line, 345, 398);
  const costPrice = lineCell(line, 398, 465);
  const closingPrice = lineCell(line, 465, 535);
  const marketValue = lineCell(line, 535, 600);
  if (![openingQty, movementQty, closingQty, costPrice, closingPrice, marketValue].every(hasNumber)) return null;

  const security = splitSecurity(item);
  if (!security.symbol) return null;

  return {
    sourcePdf,
    page: line.page,
    statementMonth,
    market,
    currency,
    symbol: security.symbol,
    securityName: security.securityName,
    openingQty: parseNumber(openingQty),
    movementQty: parseNumber(movementQty),
    closingQty: parseNumber(closingQty),
    costPrice: parseNumber(costPrice),
    closingPrice: parseNumber(closingPrice),
    marketValue: parseNumber(marketValue),
  };
}

function parseStockTradeLine(
  sourcePdf: string,
  line: TextLine,
  rawSide: string,
  sequence: number,
): TradeRecord | null {
  if (!rawSide) return null;
  const item = lineCell(line, 80, 214);
  const marketExchange = lineCell(line, 214, 280);
  const currencyText = lineCell(line, 280, 315);
  const tradeDate = lineCell(line, 315, 376);
  const settleDate = lineCell(line, 376, 448);
  const quantity = lineCell(line, 448, 482);
  const unitPrice = lineCell(line, 482, 545);
  const clearingBalance = lineCell(line, 545, 600);
  if (!DATE_RE.test(tradeDate) || !DATE_RE.test(settleDate)) return null;
  if (![item, marketExchange, currencyText, quantity, unitPrice, clearingBalance].every(Boolean)) return null;

  const currency = mapCurrency(currencyText);
  const security = splitSecurity(item);
  const side = canonicalText(rawSide).includes("卖") ? "sell" : "buy";
  return {
    product: "stock",
    sourcePdf,
    page: line.page,
    side,
    rawSide,
    market: marketFromExchange(marketExchange, currency),
    currency,
    tradeDate,
    settleDate,
    symbol: security.symbol,
    securityName: security.securityName,
    quantity: Math.abs(parseNumber(quantity)),
    unitPrice: parseNumber(unitPrice),
    clearingBalance: parseNumber(clearingBalance),
    sequence,
  };
}

function parseFundTradeLine(
  sourcePdf: string,
  line: TextLine,
  rawSide: string,
  sequence: number,
): TradeRecord | null {
  if (!rawSide) return null;
  const item = lineCell(line, 50, 220);
  const marketExchange = lineCell(line, 220, 287);
  const currencyText = lineCell(line, 287, 320);
  const tradeDate = lineCell(line, 320, 378);
  const settleDate = lineCell(line, 378, 445);
  const quantity = lineCell(line, 445, 482);
  const unitPrice = lineCell(line, 482, 545);
  const clearingBalance = lineCell(line, 545, 600);
  if (!DATE_RE.test(tradeDate) || !DATE_RE.test(settleDate)) return null;
  if (![item, marketExchange, currencyText, quantity, unitPrice, clearingBalance].every(Boolean)) return null;

  const currency = mapCurrency(currencyText);
  const security = splitSecurity(item);
  const side = canonicalText(rawSide).includes("赎") ? "sell" : "buy";
  return {
    product: "fund",
    sourcePdf,
    page: line.page,
    side,
    rawSide,
    market: marketFromExchange(marketExchange, currency),
    currency,
    tradeDate,
    settleDate,
    symbol: security.symbol,
    securityName: security.securityName,
    quantity: Math.abs(parseNumber(quantity)),
    unitPrice: parseNumber(unitPrice),
    clearingBalance: parseNumber(clearingBalance),
    sequence,
  };
}

function parseCashFlowLine(sourcePdf: string, line: TextLine, currency: Currency): CashFlowRecord | null {
  const date = lineCell(line, 0, 130);
  const ref = lineCell(line, 130, 240);
  const note = lineCell(line, 240, 540);
  const amount = lineCell(line, 540, 600);
  if (!DATE_RE.test(date) || !ref || !note || !hasNumber(amount)) return null;
  return {
    sourcePdf,
    page: line.page,
    currency,
    date,
    ref,
    note: canonicalText(note),
    amount: parseNumber(amount),
  };
}

function securityFromMoveNote(note: string) {
  const canonical = canonicalText(note);
  const us = canonical.match(/\b([A-Z]{1,6})\s*\((?:NASDAQ|NYSE|AMEX|US)\)/i);
  if (us) return { symbol: us[1].toUpperCase(), securityName: us[1].toUpperCase() };
  const hk = canonical.match(/\b0?(\d{3,5})\b/);
  if (hk) {
    const symbol = normalizeSymbol(hk[1]);
    return { symbol, securityName: symbol };
  }
  return { symbol: "UNKNOWN", securityName: "未识别证券" };
}

function parseStockMoveLine(sourcePdf: string, line: TextLine, market: string, currency: Currency): StockMoveRecord | null {
  const date = lineCell(line, 0, 130);
  const ref = lineCell(line, 130, 220);
  const note = lineCell(line, 220, 555);
  const quantity = lineCell(line, 555, 600);
  if (!DATE_RE.test(date) || !ref || !note || !hasNumber(quantity)) return null;
  const security = securityFromMoveNote(note);
  return {
    sourcePdf,
    page: line.page,
    market,
    currency,
    date,
    ref,
    note: canonicalText(note),
    symbol: security.symbol,
    securityName: security.securityName,
    quantity: parseNumber(quantity),
  };
}

function isZirconStatement(text: string) {
  const canonical = canonicalText(text);
  const lower = canonical.toLowerCase();
  return canonical.includes("卓锐证券") || lower.includes("zircon securities");
}

function parseZirconLines(sourcePdf: string, lines: TextLine[]): ZirconRawData {
  const raw: ZirconRawData = {
    trades: [],
    positions: [],
    cashFlows: [],
    stockMoves: [],
    issues: [],
    statementDetected: false,
  };

  let activeTable: "none" | "portfolio" | "cash_flow" | "stock_move" | "stock_trade" | "fund_trade" = "none";
  let statementMonth = parseStatementMonthFromFileName(sourcePdf);
  let positionMarket = "香港市场";
  let positionCurrency: Currency = "HKD";
  let cashCurrency: Currency = "HKD";
  let moveMarket = "香港市场";
  let moveCurrency: Currency = "HKD";
  let stockSide = "";
  let fundSide = "";
  let sequence = 0;

  for (const line of lines) {
    const text = canonicalText(line.text);
    if (isZirconStatement(text)) raw.statementDetected = true;
    if (!statementMonth && MONTH_RE.test(text)) statementMonth = text;

    if (text.includes("Securities Position/Portfolio Holding") || text.includes("证券组合")) {
      activeTable = "portfolio";
      continue;
    }
    if (text.includes("Monthly Withdrawals/Deposit Of Fund") || text.includes("当月资金提存交易")) {
      activeTable = "cash_flow";
      continue;
    }
    if (text.includes("Monthly Withdrawals/Deposit Of Stock") || text.includes("当月证券提存交易")) {
      activeTable = "stock_move";
      continue;
    }
    if (text.includes("Fund Transaction Details") || text.includes("基金成交信息")) {
      activeTable = "fund_trade";
      fundSide = "";
      continue;
    }
    if (text.includes("Transaction Details") || text.includes("成交信息")) {
      activeTable = "stock_trade";
      stockSide = "";
      continue;
    }
    if (text.includes("Important Notes") || text.includes("重要提示")) {
      activeTable = "none";
      continue;
    }

    if (activeTable === "portfolio") {
      const group = parseMarketGroup(text);
      if (group) {
        positionMarket = group.market;
        positionCurrency = group.currency;
        continue;
      }
      const position = parsePositionLine(sourcePdf, line, statementMonth, positionMarket, positionCurrency);
      if (position) raw.positions.push(position);
      continue;
    }

    if (activeTable === "cash_flow") {
      if (/^(USD|HKD|CNY|CNH)$/.test(text)) {
        cashCurrency = mapCurrency(text);
        continue;
      }
      const cashFlow = parseCashFlowLine(sourcePdf, line, cashCurrency);
      if (cashFlow) raw.cashFlows.push(cashFlow);
      continue;
    }

    if (activeTable === "stock_move") {
      const moveGroup = text.match(/^([A-Z]{2})-([A-Z]+)$/);
      if (moveGroup) {
        moveCurrency = moveGroup[1] === "US" ? "USD" : "HKD";
        moveMarket = marketFromExchange(moveGroup[0], moveCurrency);
        continue;
      }
      const move = parseStockMoveLine(sourcePdf, line, moveMarket, moveCurrency);
      if (move) raw.stockMoves.push(move);
      continue;
    }

    if (activeTable === "stock_trade") {
      if (text === "买入" || text === "卖出") {
        stockSide = text;
        continue;
      }
      const trade = parseStockTradeLine(sourcePdf, line, stockSide, sequence);
      if (trade) {
        raw.trades.push(trade);
        sequence += 1;
      }
      continue;
    }

    if (activeTable === "fund_trade") {
      if (text === "申购" || text === "赎回") {
        fundSide = text;
        continue;
      }
      const trade = parseFundTradeLine(sourcePdf, line, fundSide, sequence);
      if (trade) {
        raw.trades.push(trade);
        sequence += 1;
      }
    }
  }

  return raw;
}

function tradeActivityFromTrade(trade: TradeRecord): TradeActivity {
  const grossAmount = trade.quantity * trade.unitPrice;
  const amount = Math.abs(trade.clearingBalance);
  const source = trade.product === "fund" ? "基金成交信息" : "成交信息";
  return {
    id: `zircon-activity-${trade.tradeDate}-${trade.sequence}-${trade.currency}-${trade.symbol}-${trade.side}`,
    broker: ZIRCON_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: trade.market,
    currency: trade.currency,
    symbol: trade.symbol,
    securityName: trade.securityName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount,
    fee: Math.abs(amount - Math.abs(grossAmount)),
    amount,
    source,
    note: `${trade.rawSide}；交收日 ${trade.settleDate}；${trade.sourcePdf} 第 ${trade.page} 页`,
  };
}

function stockMoveActivity(move: StockMoveRecord, index: number): TradeActivity {
  return {
    id: `zircon-stock-move-${move.date}-${index}-${move.symbol}-${move.quantity}`,
    broker: ZIRCON_BROKER,
    date: move.date,
    sequence: 10_000 + index,
    market: move.market,
    currency: move.currency,
    symbol: move.symbol,
    securityName: move.securityName,
    side: move.quantity >= 0 ? "transfer_in" : "transfer_out",
    quantity: Math.abs(move.quantity),
    amount: 0,
    source: "证券提存交易",
    note: `${move.note}；公司行动/证券提存记录，已排除税务成本重放`,
    excludedFromTaxReplay: true,
  };
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

function activityKey(activity: Pick<TradeActivity, "currency" | "symbol">) {
  return `${activity.currency}::${activity.symbol}`;
}

function sortActivities(activities: TradeActivity[]) {
  const rank: Record<TradeActivity["side"], number> = {
    acquire: 1,
    transfer_in: 1,
    buy: 2,
    short_open: 2,
    short_close: 2,
    sell: 2,
    transfer_out: 3,
  };
  return [...activities].sort((a, b) => {
    return a.date.localeCompare(b.date) || rank[a.side] - rank[b.side] || (a.sequence ?? 0) - (b.sequence ?? 0);
  });
}

function buildOpeningTransfers(raw: ZirconRawData): { activities: TradeActivity[]; estimatedCount: number } {
  const sellKeys = new Set(raw.trades.filter((trade) => trade.side === "sell").map((trade) => `${trade.currency}::${trade.symbol}`));
  const earliestPositions = new Map<string, PositionRecord>();

  for (const position of raw.positions) {
    if (position.openingQty <= 0 || !sellKeys.has(`${position.currency}::${position.symbol}`)) continue;
    const key = `${position.currency}::${position.symbol}`;
    const existing = earliestPositions.get(key);
    if (!existing || position.statementMonth < existing.statementMonth) {
      earliestPositions.set(key, position);
    }
  }

  return {
    estimatedCount: earliestPositions.size,
    activities: Array.from(earliestPositions.values()).map((position, index) => ({
      id: `zircon-opening-${position.statementMonth}-${position.currency}-${position.symbol}`,
      broker: ZIRCON_BROKER,
      date: `${position.statementMonth || "2000-01"}-01`,
      sequence: -10_000 + index,
      market: position.market,
      currency: position.currency,
      symbol: position.symbol,
      securityName: position.securityName,
      side: "transfer_in",
      quantity: position.openingQty,
      amount: position.openingQty * position.costPrice,
      source: "月初持仓成本带入",
      note: "按卓锐月结单承上月结余和成本价暂估；正式申报建议用原始买入记录复核",
    })),
  };
}

function buildMissingCostRequests(baseActivities: TradeActivity[], targetYear?: number): MissingCostAggregate[] {
  const states = new Map<string, number>();
  const missing = new Map<string, MissingCostAggregate>();

  for (const activity of sortActivities(baseActivities).filter((item) => !item.excludedFromTaxReplay)) {
    const key = activityKey(activity);
    const quantity = states.get(key) ?? 0;
    if (activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in") {
      states.set(key, quantity + activity.quantity);
      continue;
    }
    if (activity.side === "sell") {
      if (quantity + 1e-7 < activity.quantity) {
        if (targetYear === undefined || activity.date.startsWith(String(targetYear))) {
          const missingKey = `${key}::${activity.id}`;
          const requestId = `zircon-cost-${targetYear ?? "unknown"}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`;
          missing.set(missingKey, {
            id: requestId,
            sellDate: activity.date,
            market: activity.market,
            currency: activity.currency,
            symbol: activity.symbol,
            securityName: activity.securityName,
            quantity: activity.quantity,
            proceeds: activity.amount,
            source: activity.source,
            sequence: activity.sequence,
          });
        }
        states.set(key, 0);
      } else {
        states.set(key, quantity - activity.quantity);
      }
      continue;
    }
    states.set(key, Math.max(0, quantity - activity.quantity));
  }

  return Array.from(missing.values());
}

function buildTradeActivities(
  raw: ZirconRawData,
  targetYear?: number,
  manualCosts: ManualCostInput[] = [],
): { activities: TradeActivity[]; realizedTrades: RealizedTrade[]; costBasisRequests: CostBasisRequest[]; issues: ReviewIssue[] } {
  const opening = buildOpeningTransfers(raw);
  const baseActivities = [
    ...opening.activities,
    ...raw.trades.map(tradeActivityFromTrade),
    ...raw.stockMoves.map(stockMoveActivity),
  ];

  const manualCostsById = manualCostMap(manualCosts);
  const missing = buildMissingCostRequests(baseActivities, targetYear);
  const manualTrades: RealizedTrade[] = [];
  const costBasisRequests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];

  for (const item of missing) {
    const manualCost = manualCostsById.get(item.id);
    if (manualCost !== undefined) {
      manualTrades.push({
        id: `${item.id}-manual`,
        broker: ZIRCON_BROKER,
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
        note: `用户手动补录这笔卖出/赎回总成本：${manualCost}`,
        useBrokerReportedGainLoss: true,
      });
    } else {
      costBasisRequests.push({
        id: item.id,
        broker: ZIRCON_BROKER,
        sellDate: item.sellDate,
        sequence: item.sequence,
        market: item.market,
        currency: item.currency,
        symbol: item.symbol,
        securityName: item.securityName,
        quantity: item.quantity,
        proceeds: item.proceeds,
        source: item.source,
        note: "手动补录这笔成本后计入资本利得",
      });
      issues.push({
        id: `${item.id}-cost-gap`,
        severity: "warning",
        title: `${item.symbol} 历史成本缺失`,
        detail: `${item.sellDate} 卖出/赎回 ${item.quantity} 份/股，但上传的卓锐月结单没有足够的月初持仓或买入记录匹配成本。请补充更早月份月结单，或在待补成本中手动填写这笔成本。`,
        source: item.source,
      });
    }
  }

  if (opening.estimatedCount > 0) {
    issues.push({
      id: "zircon-opening-cost-estimated",
      severity: "warning",
      title: "卓锐月初持仓成本按月结单暂估",
      detail:
        "系统已用卓锐月结单的“承上月结余 × 成本价”为当月卖出/赎回补齐成本。若这些持仓来自更早买入或转仓，正式申报前建议用原始成交记录复核成本。",
    });
  }

  return {
    activities: sortActivities(baseActivities),
    realizedTrades: manualTrades,
    costBasisRequests,
    issues,
  };
}

function buildOpenPositions(raw: ZirconRawData): OpenPosition[] {
  const latest = new Map<string, PositionRecord>();
  for (const position of raw.positions) {
    if (position.closingQty <= 0) continue;
    const key = `${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementMonth > existing.statementMonth) {
      latest.set(key, position);
    }
  }

  return Array.from(latest.values()).map((position) => {
    const costBasis = position.closingQty * position.costPrice;
    return {
      id: `zircon-open-${position.statementMonth}-${position.currency}-${position.symbol}`,
      broker: ZIRCON_BROKER,
      asOf: position.statementMonth ? `${position.statementMonth}-末` : "",
      market: position.market,
      currency: position.currency,
      symbol: position.symbol,
      securityName: position.securityName,
      quantity: position.closingQty,
      marketValue: position.marketValue,
      costBasis,
      unrealizedGainLoss: position.marketValue - costBasis,
      source: position.sourcePdf,
    };
  });
}

function dividendSecurityFromNote(note: string) {
  const canonical = canonicalText(note);
  const us = canonical.match(/\b([A-Z]{1,6})\s*(?:\.US|\(NASDAQ\)|\(NYSE\)|Cash Dividend|Dividend)/i);
  if (us) return { symbol: us[1].toUpperCase(), securityName: us[1].toUpperCase() };
  const hk = canonical.match(/\b0?(\d{3,5})\b/);
  if (hk) {
    const symbol = normalizeSymbol(hk[1]);
    return { symbol, securityName: symbol };
  }
  return null;
}

function buildDividends(cashFlows: CashFlowRecord[]): DividendIncome[] {
  return cashFlows.flatMap((cashFlow) => {
    const note = canonicalText(cashFlow.note);
    if (cashFlow.amount <= 0 || (!note.includes("股息") && !note.includes("分红") && !/dividend/i.test(note))) return [];
    const security = dividendSecurityFromNote(note);
    if (!security) return [];
    return [
      {
        id: `zircon-dividend-${cashFlow.date}-${security.symbol}-${cashFlow.ref}`,
        broker: ZIRCON_BROKER,
        date: cashFlow.date,
        currency: cashFlow.currency,
        symbol: security.symbol,
        securityName: security.securityName,
        grossAmount: cashFlow.amount,
        taxWithheld: 0,
        fee: 0,
        source: cashFlow.sourcePdf,
        note: cashFlow.note,
      },
    ];
  });
}

export async function parseZirconPdfs(
  files: ZirconFileInput[],
  password?: string,
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: ZirconRawData = {
    trades: [],
    positions: [],
    cashFlows: [],
    stockMoves: [],
    issues: [],
    statementDetected: false,
  };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data, password);
      const fileRaw = parseZirconLines(file.name, lines);
      raw.trades.push(...fileRaw.trades);
      raw.positions.push(...fileRaw.positions);
      raw.cashFlows.push(...fileRaw.cashFlows);
      raw.stockMoves.push(...fileRaw.stockMoves);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      raw.issues.push({
        id: `${file.name}-pdf-error`,
        severity: "blocking",
        title: "卓锐PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。请确认密码是否正确。",
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

  const hasParsedStatementRows = raw.trades.length > 0 || raw.positions.length > 0 || raw.cashFlows.length > 0 || raw.stockMoves.length > 0;
  const hasRecognizedStatement = raw.statementDetected || hasParsedStatementRows;

  if (!hasParsedStatementRows && !hasRecognizedStatement && files.length > 0) {
    parsed.issues.push({
      id: "zircon-invalid-format",
      severity: "blocking",
      title: "卓锐文件格式不符合要求",
      detail: "卓锐只支持 PDF 月结单。当前文件没有识别到成交信息、基金成交、持仓或资金/证券提存表，请确认上传的是卓锐证券月结单 PDF 且密码正确。",
    });
  }

  if (raw.trades.length === 0 && files.length > 0) {
    parsed.issues.push({
      id: hasRecognizedStatement ? "zircon-no-trade-activity" : "zircon-no-trades",
      severity: hasRecognizedStatement ? "info" : "warning",
      title: hasRecognizedStatement ? "本月没有卓锐买卖/申赎交易" : "未识别卓锐交易",
      detail: hasRecognizedStatement
        ? "已识别为卓锐证券月结单，但本月没有股票买卖或基金申赎记录。系统仍会读取月末持仓；如本月实际发生卖出，请重新下载包含成交信息的月结单后再上传。"
        : "没有从上传的卓锐 PDF 中识别到成交信息或基金成交信息。请确认文件是否为月结单且密码正确。",
    });
  }

  return parsed;
}
