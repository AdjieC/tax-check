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

interface UsmartFileInput {
  name: string;
  data: ArrayBuffer;
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
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  side: "buy" | "sell";
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  cashChange: number;
  tradeDate: string;
  settleDate: string;
}

interface PendingTrade {
  sourcePdf: string;
  page: number;
  sequence: number;
  orderId: string;
  item: string;
  market: string;
  currency: Currency;
  side: "buy" | "sell";
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  tradeDate: string;
  settleDate: string;
}

interface PositionRecord {
  sourcePdf: string;
  page: number;
  statementMonth: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  unsettledQuantity: number;
  price: number;
  marketValue: number;
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  flowType: string;
  currency: Currency;
  amount: number;
  date: string;
  note: string;
}

interface UsmartRawData {
  trades: TradeRecord[];
  positions: PositionRecord[];
  cashFlows: CashFlowRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

export interface ManualCostInput {
  id: string;
  costBasis: number;
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
  proceeds: number;
  source: string;
}

const USMART_BROKER = "盈立";

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("證", "证")
    .replaceAll("賬", "账")
    .replaceAll("帳", "账")
    .replaceAll("戶", "户")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("費", "费")
    .replaceAll("額", "额")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("幣", "币")
    .replaceAll("種", "种")
    .replaceAll("續", "续")
    .replaceAll("備", "备")
    .replaceAll("註", "注")
    .replaceAll("紅", "红")
    .replaceAll("稅", "税")
    .replaceAll("資", "资")
    .replaceAll("產", "产")
    .replaceAll("負", "负");
}

function parseNumber(value: string) {
  const text = canonicalText(value).replace(/,/g, "").replace(/[()]/g, "").trim();
  if (!text || text === "--") return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function marketName(value: string, currency: Currency) {
  const text = canonicalText(value);
  if (text.includes("美股")) return "美国市场";
  if (text.includes("港股")) return "香港市场";
  if (text.includes("A股")) return "A股通";
  if (currency === "USD") return "美国市场";
  if (currency === "CNY") return "A股通";
  return "香港市场";
}

function normalizeDate(value: string) {
  return canonicalText(value).replace(/\//g, "-");
}

function normalizeSecurityItem(value: string) {
  return canonicalText(value)
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+([）)])/g, "$1")
    .replace(/([（(])\s+/g, "$1")
    .replace(/([^\x00-\x7F])\s+([^\x00-\x7F])/g, "$1$2");
}

function securityFromItem(item: string, currency: Currency): { symbol: string; securityName: string; market: string } {
  const normalized = normalizeSecurityItem(item);
  const match = normalized.match(/^([A-Z]{1,8}|HK\d{3,8}|\d{3,6})(?:\s*[（(]([^）)]*)[）)])?/i);
  if (!match) {
    return {
      symbol: normalized || "UNKNOWN",
      securityName: normalized || "未识别证券",
      market: marketName("", currency),
    };
  }

  const rawSymbol = match[1].toUpperCase();
  const symbol = /^\d+$/.test(rawSymbol) ? normalizeSymbol(rawSymbol) : rawSymbol.replace(/^HK0*/i, "");
  const rawName = clean(match[2] ?? "");
  const securityName = rawName && rawName.toUpperCase() !== symbol ? rawName : symbol;
  return {
    symbol,
    securityName,
    market: marketName("", currency),
  };
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
    if (/^[+-]?\d[\d,]*(?:\.\d+)?$/.test(text)) return text;
  }
  return "";
}

function isDate(value: string) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(normalizeDate(value));
}

function isUsmartStatement(text: string) {
  const canonical = canonicalText(text);
  const lower = canonical.toLowerCase();
  return canonical.includes("盈立证券") || lower.includes("usmart securities") || lower.includes("usmarthk.com");
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

function parseTradeMainLine(sourcePdf: string, line: TextLine, sequence: number, securityParts: string[]): PendingTrade | null {
  const market = lineCell(line, 88, 126);
  const sideText = canonicalText(lineCell(line, 126, 158));
  const quantity = lineCell(line, 158, 188);
  const currencyText = lineCell(line, 188, 225);
  const unitPrice = lineCell(line, 225, 300);
  const grossAmount = lineCell(line, 300, 355);
  const tradeDate = lineCell(line, 355, 430);
  const settleDate = lineCell(line, 500, 590);
  const item = normalizeSecurityItem(lineCell(line, 0, 88) || securityParts.join(" "));

  if (!market || !sideText || !quantity || !currencyText || !unitPrice || !grossAmount || !isDate(tradeDate) || !isDate(settleDate)) {
    return null;
  }
  if (!sideText.includes("买") && !sideText.includes("卖")) return null;

  const currency = mapCurrency(currencyText);
  return {
    sourcePdf,
    page: line.page,
    sequence,
    orderId: "",
    item,
    market: marketName(market, currency),
    currency,
    side: sideText.includes("买") ? "buy" : "sell",
    quantity: parseNumber(quantity),
    unitPrice: parseNumber(unitPrice),
    grossAmount: parseNumber(grossAmount),
    tradeDate: normalizeDate(tradeDate),
    settleDate: normalizeDate(settleDate),
  };
}

function isSecurityTextLine(line: TextLine) {
  if (line.tokens.length === 0) return false;
  if (line.tokens.some((token) => token.x >= 88)) return false;
  const text = canonicalText(line.text);
  if (!text || /^\d+$/.test(text)) return false;
  if (/^(证券|交易|持仓|资金|币种|客户|地址|电话|月结单|结单日期|印单日期)/.test(text)) return false;
  return /^[A-Z]{1,8}\b/i.test(text) || /[）)]$/.test(text) || text.length <= 20;
}

function finalizePendingTrade(pending: PendingTrade, cashChange: number): TradeRecord {
  const security = securityFromItem(pending.item, pending.currency);
  return {
    sourcePdf: pending.sourcePdf,
    page: pending.page,
    sequence: pending.sequence,
    orderId: pending.orderId,
    market: pending.market || security.market,
    currency: pending.currency,
    symbol: security.symbol,
    securityName: security.securityName,
    side: pending.side,
    quantity: pending.quantity,
    unitPrice: pending.unitPrice,
    grossAmount: pending.grossAmount,
    cashChange,
    tradeDate: pending.tradeDate,
    settleDate: pending.settleDate,
  };
}

function parsePositionLine(sourcePdf: string, line: TextLine, statementMonth: string): PositionRecord | null {
  const text = canonicalText(line.text);
  const match = text.match(
    /^(.+?)\s+(HKD|USD|CNY)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+[\d.]+%\s+([+-]?\d[\d,]*(?:\.\d+)?)$/,
  );
  if (!match) return null;

  const currency = mapCurrency(match[2]);
  const security = securityFromItem(match[1], currency);
  return {
    sourcePdf,
    page: line.page,
    statementMonth,
    market: security.market,
    currency,
    symbol: security.symbol,
    securityName: security.securityName,
    quantity: parseNumber(match[3]),
    unsettledQuantity: parseNumber(match[4]),
    price: parseNumber(match[5]),
    marketValue: parseNumber(match[6]),
  };
}

function parseCashFlowLine(sourcePdf: string, line: TextLine): CashFlowRecord | null {
  const text = canonicalText(line.text);
  const match = text.match(/^(.+?)\s+(HKD|USD|CNY)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+(20\d{2}-\d{2}-\d{2})(?:\s+(.*))?$/);
  if (!match) return null;
  return {
    sourcePdf,
    page: line.page,
    flowType: clean(match[1]),
    currency: mapCurrency(match[2]),
    amount: parseNumber(match[3]),
    date: normalizeDate(match[4]),
    note: clean(match[5] ?? ""),
  };
}

function parseStatementMonth(text: string) {
  const match = canonicalText(text).match(/结单日期[:：]\s*(20\d{2})-(0[1-9]|1[0-2])/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function parseUsmartLines(sourcePdf: string, lines: TextLine[]): UsmartRawData {
  const raw: UsmartRawData = {
    trades: [],
    positions: [],
    cashFlows: [],
    issues: [],
    statementDetected: false,
  };

  let activeTable: "none" | "trade" | "portfolio" | "cash_flow" = "none";
  let statementMonth = "";
  let sequence = 0;
  let nextSecurityParts: string[] = [];
  let pendingTrade: PendingTrade | null = null;

  const finishPendingTrade = (cashChange?: number) => {
    if (!pendingTrade) return;
    const fallbackCash = pendingTrade.side === "buy" ? -pendingTrade.grossAmount : pendingTrade.grossAmount;
    raw.trades.push(finalizePendingTrade(pendingTrade, cashChange ?? fallbackCash));
    pendingTrade = null;
    sequence += 1;
  };

  for (const line of lines) {
    const text = canonicalText(line.text);
    if (isUsmartStatement(text)) raw.statementDetected = true;
    statementMonth = statementMonth || parseStatementMonth(text);

    if (text.includes("交易明细")) {
      activeTable = "trade";
      continue;
    }
    if (text.includes("持仓明细")) {
      finishPendingTrade();
      activeTable = "portfolio";
      continue;
    }
    if (text.includes("资金出入")) {
      finishPendingTrade();
      activeTable = "cash_flow";
      continue;
    }
    if (text.includes("证券提存") || text.includes("融资利息") || text.includes("重要提示")) {
      finishPendingTrade();
      activeTable = "none";
      continue;
    }

    if (activeTable === "trade") {
      if (text.includes("证券/编号") || text.includes("交收费") || text.includes("交易金额")) continue;

      const trade = parseTradeMainLine(sourcePdf, line, sequence, nextSecurityParts);
      if (trade) {
        if (pendingTrade) finishPendingTrade();
        pendingTrade = trade;
        nextSecurityParts = [];
        continue;
      }

      if (pendingTrade && isSecurityTextLine(line)) {
        pendingTrade.item = normalizeSecurityItem(`${pendingTrade.item} ${line.text}`);
        continue;
      }

      if (!pendingTrade && isSecurityTextLine(line)) {
        nextSecurityParts = [line.text];
        continue;
      }

      if (pendingTrade && /^\d{6,}$/.test(line.tokens[0]?.text ?? "")) {
        pendingTrade.orderId = pendingTrade.orderId || line.tokens[0].text;
      }

      if (pendingTrade && text.includes("变动金额合计")) {
        finishPendingTrade(parseNumber(rightmostNumber(line)));
      }
      continue;
    }

    if (activeTable === "portfolio") {
      if (text.includes("证券 币种") || text.startsWith("币种 ") || text.includes("市值汇总")) continue;
      const position = parsePositionLine(sourcePdf, line, statementMonth);
      if (position) raw.positions.push(position);
      continue;
    }

    if (activeTable === "cash_flow") {
      if (text.includes("业务标志") || text.startsWith("币种 ") || text.includes("变动金额汇总")) continue;
      const cashFlow = parseCashFlowLine(sourcePdf, line);
      if (cashFlow) raw.cashFlows.push(cashFlow);
    }
  }

  finishPendingTrade();
  return raw;
}

function tradeActivityFromTrade(trade: TradeRecord): TradeActivity {
  const amount = roundMoney(Math.abs(trade.cashChange));
  return {
    id: `usmart-activity-${trade.tradeDate}-${trade.sequence}-${trade.currency}-${trade.symbol}-${trade.side}`,
    broker: USMART_BROKER,
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
    fee: roundMoney(Math.abs(amount - Math.abs(trade.grossAmount))),
    amount,
    source: "交易明细",
    note: `${trade.orderId ? `订单 ${trade.orderId}；` : ""}交收日 ${trade.settleDate}；${trade.sourcePdf} 第 ${trade.page} 页`,
  };
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

  for (const activity of sortActivities(activities)) {
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
            id: `usmart-cost-${targetYear ?? "unknown"}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`,
            sellDate: activity.date,
            sequence: activity.sequence,
            market: activity.market,
            currency: activity.currency,
            symbol: activity.symbol,
            securityName: activity.securityName,
            quantity: activity.quantity,
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
  raw: UsmartRawData,
  targetYear?: number,
  manualCosts: ManualCostInput[] = [],
): { activities: TradeActivity[]; realizedTrades: RealizedTrade[]; costBasisRequests: CostBasisRequest[]; issues: ReviewIssue[] } {
  const activities = raw.trades.map(tradeActivityFromTrade);
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
        broker: USMART_BROKER,
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
      broker: USMART_BROKER,
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
      detail: `${item.sellDate} 卖出 ${item.quantity} 股，但上传的盈立月结单没有足够的当月买入记录匹配成本。请补充更早月份月结单，或在待补成本中手动填写这笔成本。`,
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

function buildOpenPositions(raw: UsmartRawData): OpenPosition[] {
  const latest = new Map<string, PositionRecord>();
  for (const position of raw.positions) {
    if (position.quantity <= 0) continue;
    const key = `${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementMonth > existing.statementMonth) latest.set(key, position);
  }

  return Array.from(latest.values()).map((position) => ({
    id: `usmart-open-${position.statementMonth}-${position.currency}-${position.symbol}`,
    broker: USMART_BROKER,
    asOf: position.statementMonth ? `${position.statementMonth}-末` : "",
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    source: position.sourcePdf,
    note: position.unsettledQuantity ? `未交收数量 ${position.unsettledQuantity}` : undefined,
  }));
}

function dividendSymbolFromNote(note: string) {
  return canonicalText(note).match(/\b([A-Z]{1,6})(?:\.US)?\b/i)?.[1].toUpperCase() ?? null;
}

function buildDividends(cashFlows: CashFlowRecord[]): DividendIncome[] {
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
      note: string;
    }
  >();

  for (const cashFlow of cashFlows) {
    const flowType = canonicalText(cashFlow.flowType);
    const note = canonicalText(cashFlow.note);
    if (!flowType.includes("红利") && !flowType.includes("股息") && !note.includes("红利") && !note.includes("股息")) continue;

    const symbol = dividendSymbolFromNote(cashFlow.note);
    if (!symbol) continue;
    const key = `${cashFlow.date}-${cashFlow.currency}-${symbol}`;
    const aggregate =
      aggregates.get(key) ??
      ({
        date: cashFlow.date,
        currency: cashFlow.currency,
        symbol,
        grossAmount: 0,
        taxWithheld: 0,
        fee: 0,
        source: cashFlow.sourcePdf,
        note: cashFlow.note,
      } satisfies {
        date: string;
        currency: Currency;
        symbol: string;
        grossAmount: number;
        taxWithheld: number;
        fee: number;
        source: string;
        note: string;
      });

    if (cashFlow.amount > 0 && flowType.includes("红利")) {
      aggregate.grossAmount += cashFlow.amount;
      aggregate.note = cashFlow.note || aggregate.note;
    } else if (cashFlow.amount < 0 && (flowType.includes("税") || note.includes("税"))) {
      aggregate.taxWithheld += Math.abs(cashFlow.amount);
    } else if (cashFlow.amount < 0 && (flowType.includes("代收费") || flowType.includes("代收费") || note.includes("代收费"))) {
      aggregate.fee += Math.abs(cashFlow.amount);
    }

    aggregates.set(key, aggregate);
  }

  return Array.from(aggregates.values())
    .filter((item) => item.grossAmount > 0)
    .map((item) => ({
      id: `usmart-dividend-${item.date}-${item.currency}-${item.symbol}`,
      broker: USMART_BROKER,
      date: item.date,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.symbol,
      grossAmount: item.grossAmount,
      taxWithheld: item.taxWithheld,
      fee: item.fee,
      source: item.source,
      note: item.note,
    }));
}

export async function parseUsmartPdfs(
  files: UsmartFileInput[],
  password?: string,
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: UsmartRawData = {
    trades: [],
    positions: [],
    cashFlows: [],
    issues: [],
    statementDetected: false,
  };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data, password);
      const fileRaw = parseUsmartLines(file.name, lines);
      raw.trades.push(...fileRaw.trades);
      raw.positions.push(...fileRaw.positions);
      raw.cashFlows.push(...fileRaw.cashFlows);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      raw.issues.push({
        id: `${file.name}-pdf-error`,
        severity: "blocking",
        title: "盈立PDF解析失败",
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

  const hasParsedStatementRows = raw.trades.length > 0 || raw.positions.length > 0 || raw.cashFlows.length > 0;
  const hasRecognizedStatement = raw.statementDetected || hasParsedStatementRows;

  if (!hasParsedStatementRows && !hasRecognizedStatement && files.length > 0) {
    parsed.issues.push({
      id: "usmart-invalid-format",
      severity: "blocking",
      title: "盈立文件格式不符合要求",
      detail: "盈立只支持 PDF 月结单。当前文件没有识别到交易明细、持仓明细或资金出入表，请确认上传的是盈立证券月结单 PDF。",
    });
  }

  if (raw.trades.length === 0 && files.length > 0) {
    parsed.issues.push({
      id: hasRecognizedStatement ? "usmart-no-stock-activity" : "usmart-no-trades",
      severity: hasRecognizedStatement ? "info" : "warning",
      title: hasRecognizedStatement ? "本月没有盈立股票交易" : "未识别盈立股票交易",
      detail: hasRecognizedStatement
        ? "已识别为盈立月结单，但本月没有股票买卖记录。系统会按无股票交易处理。"
        : "没有从上传的盈立 PDF 中识别到交易明细表，请确认文件是否为月结单。",
    });
  }

  return parsed;
}
