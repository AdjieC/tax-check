import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type {
  Currency,
  DividendIncome,
  OpenPosition,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  TradeActivity,
} from "@/lib/tax/types";

interface LongbridgeFileInput {
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

interface StockTradeRecord {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  tradeDate: string;
  settleDate: string;
  orderId: string;
  side: string;
  code: string;
  name: string;
  quantity: number;
  avgPrice: number;
  tradeAmount: number;
  cashChange: number;
  sequence: number;
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  currency: Currency;
  date: string;
  flowType: string;
  note: string;
  amount: number;
}

interface PositionMoveRecord {
  sourcePdf: string;
  page: number;
  market: string;
  date: string;
  moveType: string;
  code: string;
  name: string;
  note: string;
  quantity: number;
}

interface PortfolioRecord {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  code: string;
  name: string;
  beginQty: number;
  changeQty: number;
  endQty: number;
  price: number;
  marketValue: number;
  avgCost: number;
  unrealizedGainLoss: number;
}

interface LongbridgeRawData {
  trades: StockTradeRecord[];
  cashFlows: CashFlowRecord[];
  moves: PositionMoveRecord[];
  positions: PortfolioRecord[];
  issues: ReviewIssue[];
}

interface PositionState {
  market: string;
  currency: Currency;
  name: string;
  quantity: number;
  costBasis: number;
}

type EventRecord =
  | {
      kind: "acquire" | "transfer_in";
      date: string;
      rank: number;
      sequence: number;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      cost: number;
      source: string;
      note: string;
    }
  | {
      kind: "buy" | "sell";
      date: string;
      rank: number;
      sequence: number;
      time: string;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      unitPrice: number;
      grossAmount: number;
      fee: number;
      cash: number;
      source: string;
      note: string;
    }
  | {
      kind: "transfer_out";
      date: string;
      rank: number;
      sequence: number;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      source: string;
      note: string;
    };

const DATE_RE = /^20\d{2}\.\d{2}\.\d{2}$/;
const ORDER_TIME_OVERRIDE: Record<string, string> = {
  OS20251230158712: "14:03:15",
  OS20251230175778: "14:03:51",
  OS20251230163762: "14:07:30",
  OS20251230161719: "14:08:18",
  OS20251230176385: "14:13:50",
  OS20251230173008: "14:14:02",
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return value
    .replaceAll("⽣", "生")
    .replaceAll("⽇", "日")
    .replaceAll("⾦", "金")
    .replaceAll("⾹", "香")
    .replaceAll("⼊", "入")
    .replaceAll("⽬", "目")
    .replaceAll("⼿", "手")
    .replaceAll("⾏", "行")
    .replaceAll("⽤", "用");
}

function parseNumber(value: string) {
  const parsed = Number(value.replace(/,/g, "").replace(/[()]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDate(value: string) {
  return value.replace(/\./g, "-");
}

function normalizeCode(value: string) {
  const text = value.trim().toUpperCase();
  return /^\d+$/.test(text) ? text.replace(/^0+/, "") || "0" : text;
}

function displayCode(value: string) {
  const text = value.trim().toUpperCase();
  return /^\d+$/.test(text) ? text.padStart(5, "0") : text;
}

function mapCurrency(value: string): Currency {
  if (value.includes("美元") || value.toUpperCase().includes("USD")) return "USD";
  if (value.includes("人民币") || value.toUpperCase().includes("CNY")) return "CNY";
  return "HKD";
}

function splitSecurity(item: string) {
  const [code = "", ...nameParts] = clean(item).split(" ");
  return {
    code: normalizeCode(code),
    name: nameParts.join(" "),
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

function hasDateAtStart(line: TextLine) {
  const first = line.tokens[0]?.text;
  return Boolean(first && DATE_RE.test(first));
}

async function extractPdfLines(fileName: string, data: ArrayBuffer, password?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
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

    const lines = groups
      .sort((a, b) => b.y - a.y)
      .map((group) => {
        const sortedTokens = group.tokens.sort((a, b) => a.x - b.x);
        return {
          page: pageNumber,
          text: clean(sortedTokens.map((token) => token.text).join(" ")),
          tokens: sortedTokens,
        };
      });
    pages.push(lines);
  }

  if (pages.length === 0) {
    throw new Error(`${fileName} 没有可解析页面`);
  }

  return pages.flat();
}

function parseStockTradeLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
  currency: Currency,
  sequence: number,
): StockTradeRecord | null {
  if (!hasDateAtStart(line)) return null;
  const tradeDate = lineCell(line, 0, 76);
  const settleDate = lineCell(line, 76, 137);
  const orderId = lineCell(line, 137, 220);
  const side = lineCell(line, 220, 252);
  const item = lineCell(line, 252, 358);
  const quantity = lineCell(line, 358, 402);
  const avgPrice = lineCell(line, 402, 455);
  const tradeAmount = lineCell(line, 455, 525);
  const cashChange = lineCell(line, 525, 610);

  if (!DATE_RE.test(tradeDate) || !DATE_RE.test(settleDate) || !/^OS\d+/.test(orderId)) {
    return null;
  }
  if (!side.includes("买") && !side.includes("卖")) return null;

  const security = splitSecurity(item);
  if (!security.code || !quantity || !avgPrice || !tradeAmount || !cashChange) return null;

  return {
    sourcePdf,
    page: line.page,
    market,
    currency,
    tradeDate,
    settleDate,
    orderId,
    side,
    code: security.code,
    name: security.name,
    quantity: parseNumber(quantity),
    avgPrice: parseNumber(avgPrice),
    tradeAmount: parseNumber(tradeAmount),
    cashChange: parseNumber(cashChange),
    sequence,
  };
}

function parseCashFlowLine(
  sourcePdf: string,
  line: TextLine,
  currency: Currency,
): CashFlowRecord | null {
  if (!hasDateAtStart(line)) return null;
  const date = lineCell(line, 0, 105);
  const flowType = lineCell(line, 105, 260);
  const note = lineCell(line, 260, 520);
  const amount = lineCell(line, 520, 610);

  if (!DATE_RE.test(date) || !flowType || !amount) return null;

  return {
    sourcePdf,
    page: line.page,
    currency,
    date,
    flowType,
    note,
    amount: parseNumber(amount),
  };
}

function parsePositionMoveLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
): PositionMoveRecord | null {
  if (!hasDateAtStart(line)) return null;
  const tokens = line.tokens;
  const date = tokens[0]?.text ?? "";
  const quantity = tokens.at(-1)?.text ?? "";

  const codeIndex = tokens.findIndex((token, index) => {
    if (index < 2 || token.x > 320) return false;
    return /^\d{3,5}$/.test(token.text) || /^[A-Z]{1,5}$/.test(token.text) || /^HK\d{6,}$/.test(token.text);
  });
  if (codeIndex < 2) return null;

  const noteStartIndex = tokens.findIndex((token, index) => {
    if (index <= codeIndex || index >= tokens.length - 1) return false;
    return token.x >= 340 || /^IPO\b/i.test(token.text) || token.text === "申购" || token.text === "赎回";
  });
  const itemEndIndex = noteStartIndex > 0 ? noteStartIndex : tokens.length - 1;
  const moveType = clean(tokens.slice(1, codeIndex).map((token) => token.text).join(" "));
  const item = clean(tokens.slice(codeIndex, itemEndIndex).map((token) => token.text).join(" "));
  const note =
    noteStartIndex > 0
      ? clean(tokens.slice(noteStartIndex, tokens.length - 1).map((token) => token.text).join(" "))
      : "";

  if (!DATE_RE.test(date) || !moveType || !item || !quantity) return null;
  const security = splitSecurity(item);

  return {
    sourcePdf,
    page: line.page,
    market,
    date,
    moveType,
    code: security.code,
    name: security.name,
    note,
    quantity: parseNumber(quantity),
  };
}

function parsePortfolioLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
  currency: Currency,
): PortfolioRecord | null {
  const item = lineCell(line, 0, 120);
  if (!item || item.startsWith("汇总") || item.startsWith("股票") || item.startsWith("余额通")) {
    return null;
  }

  const beginQty = lineCell(line, 120, 170);
  const changeQty = lineCell(line, 170, 225);
  const endQty = lineCell(line, 225, 275);
  const price = lineCell(line, 275, 318);
  const marketValue = lineCell(line, 318, 370);
  const avgCost = lineCell(line, 370, 414);
  const unrealizedGainLoss = lineCell(line, 414, 470);

  if (!beginQty || !changeQty || !endQty || !price || !marketValue || !avgCost || !unrealizedGainLoss) {
    return null;
  }

  const security = splitSecurity(item);
  if (!security.code) return null;

  return {
    sourcePdf,
    page: line.page,
    market,
    currency,
    code: security.code,
    name: security.name,
    beginQty: parseNumber(beginQty),
    changeQty: parseNumber(changeQty),
    endQty: parseNumber(endQty),
    price: parseNumber(price),
    marketValue: parseNumber(marketValue),
    avgCost: parseNumber(avgCost),
    unrealizedGainLoss: parseNumber(unrealizedGainLoss),
  };
}

function parseLongbridgeLines(sourcePdf: string, lines: TextLine[]): LongbridgeRawData {
  const raw: LongbridgeRawData = {
    trades: [],
    cashFlows: [],
    moves: [],
    positions: [],
    issues: [],
  };

  let activeTable: "none" | "portfolio" | "stock_trade" | "cash_flow" | "position_move" = "none";
  let tradeMarket = "";
  let tradeCurrency: Currency = "HKD";
  let cashCurrency: Currency = "HKD";
  let moveMarket = "";
  let portfolioMarket = "";
  let portfolioCurrency: Currency = "HKD";
  let sequence = 0;

  for (const line of lines) {
    const text = canonicalText(line.text);
    if (text.includes("项目") && text.includes("期初持仓") && text.includes("浮动盈亏")) {
      activeTable = "portfolio";
      continue;
    }
    if (text.includes("交易日期") && text.includes("编号") && text.includes("变动金额")) {
      activeTable = "stock_trade";
      continue;
    }
    if (text.includes("发生日期") && text.includes("类型") && text.includes("备注") && text.includes("金额")) {
      activeTable = "cash_flow";
      continue;
    }
    if (text.includes("发生日期") && text.includes("类型") && text.includes("项目") && text.includes("数量")) {
      activeTable = "position_move";
      continue;
    }

    const tradeMarketMatch = text.match(/^市场:\s*(.+?);\s*币种:\s*(.+)$/);
    if (tradeMarketMatch && activeTable === "stock_trade") {
      tradeMarket = tradeMarketMatch[1];
      tradeCurrency = mapCurrency(tradeMarketMatch[2]);
      continue;
    }

    const portfolioMarketMatch = text.match(/^股票\s+\((.+?);\s*(.+?)\)$/);
    if (portfolioMarketMatch && activeTable === "portfolio") {
      portfolioMarket = portfolioMarketMatch[1];
      portfolioCurrency = mapCurrency(portfolioMarketMatch[2]);
      continue;
    }

    if (text.startsWith("币种:") && activeTable === "cash_flow") {
      cashCurrency = mapCurrency(text.replace("币种:", ""));
      continue;
    }

    if (text.startsWith("市场:") && activeTable === "position_move") {
      moveMarket = text.replace("市场:", "").trim();
      continue;
    }

    if (activeTable === "stock_trade") {
      const trade = parseStockTradeLine(sourcePdf, line, tradeMarket, tradeCurrency, sequence);
      if (trade) {
        raw.trades.push(trade);
        sequence += 1;
      }
      continue;
    }

    if (activeTable === "cash_flow") {
      const cashFlow = parseCashFlowLine(sourcePdf, line, cashCurrency);
      if (cashFlow) raw.cashFlows.push(cashFlow);
      continue;
    }

    if (activeTable === "position_move") {
      const move = parsePositionMoveLine(sourcePdf, line, moveMarket);
      if (move) raw.moves.push(move);
      continue;
    }

    if (activeTable === "portfolio") {
      const position = parsePortfolioLine(sourcePdf, line, portfolioMarket, portfolioCurrency);
      if (position) raw.positions.push(position);
    }
  }

  return raw;
}

function extractIpoCode(note: string) {
  const match = note.match(/IPO\s+(\d+)\.HK/i);
  return match ? normalizeCode(match[1]) : null;
}

function buildDividends(cashFlows: CashFlowRecord[]): DividendIncome[] {
  const dividends: DividendIncome[] = [];
  const pendingWithholding = new Map<string, number>();

  for (const cashFlow of cashFlows) {
    const flowType = canonicalText(cashFlow.flowType);
    const note = canonicalText(cashFlow.note);
    const dividendMatch = cashFlow.note.match(/([A-Z]{1,5})\.US\s+Cash Dividend/i);
    if (flowType.includes("分红") && dividendMatch && cashFlow.amount > 0) {
      const symbol = dividendMatch[1].toUpperCase();
      const key = `${cashFlow.date}-${symbol}`;
      dividends.push({
        id: `${cashFlow.sourcePdf}-dividend-${symbol}-${cashFlow.date}`,
        broker: "长桥",
        date: normalizeDate(cashFlow.date),
        currency: cashFlow.currency,
        symbol,
        securityName: symbol,
        grossAmount: cashFlow.amount,
        taxWithheld: pendingWithholding.get(key) ?? 0,
        fee: 0,
        source: cashFlow.sourcePdf,
        note: cashFlow.note,
      });
      pendingWithholding.delete(key);
      continue;
    }

    if (note.includes("Withholding Tax/Dividend Fee") || (flowType.includes("公司行动其他费用") && note.includes("Cash Dividend"))) {
      const taxMatch = cashFlow.note.match(/([A-Z]{1,5})\.US\s+Cash Dividend/i);
      const symbol = taxMatch?.[1].toUpperCase();
      if (!symbol) continue;
      const key = `${cashFlow.date}-${symbol}`;
      const existing = dividends.find((dividend) => dividend.date === normalizeDate(cashFlow.date) && dividend.symbol === symbol);
      if (existing) {
        existing.taxWithheld += Math.abs(cashFlow.amount);
      } else {
        pendingWithholding.set(key, (pendingWithholding.get(key) ?? 0) + Math.abs(cashFlow.amount));
      }
    }
  }

  return dividends;
}

function stateAvgCost(state: PositionState) {
  return Math.abs(state.quantity) < 1e-9 ? 0 : state.costBasis / state.quantity;
}

function activityAmount(event: EventRecord) {
  if ("cash" in event) return event.kind === "buy" ? -event.cash : event.cash;
  if (event.kind === "transfer_out") return 0;
  return event.cost;
}

function buildTradeActivities(events: EventRecord[]): TradeActivity[] {
  return events.map((event) => ({
    id: `longbridge-activity-${event.date}-${event.sequence}-${displayCode(event.code)}-${event.kind}`,
    broker: "长桥",
    date: event.date,
    time: "time" in event ? event.time : undefined,
    sequence: event.sequence,
    market: event.market,
    currency: event.currency,
    symbol: displayCode(event.code),
    securityName: event.name,
    side: event.kind,
    quantity: event.quantity,
    unitPrice: "unitPrice" in event ? event.unitPrice : undefined,
    grossAmount: "grossAmount" in event ? event.grossAmount : undefined,
    fee: "fee" in event ? event.fee : undefined,
    amount: activityAmount(event),
    source: event.source,
    note: event.note,
  }));
}

function buildRealizedTrades(raw: LongbridgeRawData): {
  trades: RealizedTrade[];
  issues: ReviewIssue[];
  activities: TradeActivity[];
} {
  const issues: ReviewIssue[] = [];
  const allottedCodes = new Set(
    raw.moves.filter((move) => canonicalText(move.moveType).includes("中签")).map((move) => normalizeCode(move.code)),
  );

  const ipoCostByCode = new Map<string, number>();
  for (const cashFlow of raw.cashFlows) {
    const flowType = canonicalText(cashFlow.flowType);
    const code = extractIpoCode(cashFlow.note);
    if (!code || !allottedCodes.has(code)) continue;
    if (flowType.includes("新股中签款扣除") || flowType.includes("新股认购")) {
      ipoCostByCode.set(code, (ipoCostByCode.get(code) ?? 0) + Math.abs(cashFlow.amount));
    }
  }

  const portfolioLookup = new Map<string, PortfolioRecord>();
  for (const position of raw.positions) {
    portfolioLookup.set(`${position.sourcePdf}::${position.code}`, position);
  }

  const events: EventRecord[] = [];
  let sequence = 0;

  for (const move of raw.moves) {
    const moveType = canonicalText(move.moveType);
    if (moveType.includes("中签")) {
      events.push({
        kind: "acquire",
        date: normalizeDate(move.date),
        rank: 1,
        sequence,
        market: move.market,
        currency: "HKD",
        code: move.code,
        name: move.name,
        quantity: move.quantity,
        cost: ipoCostByCode.get(move.code) ?? 0,
        source: "IPO中签扣款+申购手续费",
        note: move.note,
      });
      sequence += 1;
    } else if (moveType.includes("证券转入")) {
      const position = portfolioLookup.get(`${move.sourcePdf}::${move.code}`);
      events.push({
        kind: "transfer_in",
        date: normalizeDate(move.date),
        rank: 1,
        sequence,
        market: move.market,
        currency: position?.currency ?? "USD",
        code: move.code,
        name: move.name,
        quantity: move.quantity,
        cost: move.quantity * (position?.avgCost ?? 0),
        source: "证券转入-按长桥月末成本基准",
        note: "转入成本需用原券商成本凭证复核",
      });
      issues.push({
        id: `${move.sourcePdf}-${move.code}-transfer-in`,
        severity: "warning",
        title: `${displayCode(move.code)} 转入成本需复核`,
        detail: "已按长桥月结单月末成本基准暂估；正式申报建议用转出券商原始成本凭证确认。",
        source: move.sourcePdf,
      });
      sequence += 1;
    } else if (moveType.includes("证券转出")) {
      const position = portfolioLookup.get(`${move.sourcePdf}::${move.code}`);
      events.push({
        kind: "transfer_out",
        date: normalizeDate(move.date),
        rank: 3,
        sequence,
        market: move.market,
        currency: position?.currency ?? "USD",
        code: move.code,
        name: move.name,
        quantity: Math.abs(move.quantity),
        source: "证券转出",
        note: "转仓，不按卖出确认收益",
      });
      issues.push({
        id: `${move.sourcePdf}-${move.code}-transfer-out`,
        severity: "warning",
        title: `${displayCode(move.code)} 已转出，未在长桥实现卖出`,
        detail: "证券转出不按卖出确认收益；如果转出后在其他券商卖出，需要继续接入该券商记录。",
        source: move.sourcePdf,
      });
      sequence += 1;
    }
  }

  for (const trade of raw.trades) {
    const isBuy = trade.side.includes("买");
    const isSell = trade.side.includes("卖");
    if (!isBuy && !isSell) continue;
    events.push({
      kind: isBuy ? "buy" : "sell",
      date: normalizeDate(trade.tradeDate),
      rank: 2,
      sequence: trade.sequence + sequence,
      time: ORDER_TIME_OVERRIDE[trade.orderId] ?? "99:99:99",
      market: trade.market,
      currency: trade.currency,
      code: trade.code,
      name: trade.name,
      quantity: trade.quantity,
      unitPrice: trade.avgPrice,
      grossAmount: trade.tradeAmount,
      fee: Math.abs(Math.abs(trade.cashChange) - Math.abs(trade.tradeAmount)),
      cash: trade.cashChange,
      source: "股票交易流水",
      note: trade.orderId,
    });
  }

  events.sort((a, b) => {
    return (
      a.date.localeCompare(b.date) ||
      a.rank - b.rank ||
      ("time" in a ? a.time : "99:99:99").localeCompare("time" in b ? b.time : "99:99:99") ||
      a.sequence - b.sequence
    );
  });

  const states = new Map<string, PositionState>();
  const realizedTrades: RealizedTrade[] = [];

  for (const event of events) {
    const key = `${event.currency}::${event.code}`;
    const state = states.get(key) ?? {
      market: event.market,
      currency: event.currency,
      name: event.name,
      quantity: 0,
      costBasis: 0,
    };
    state.market = event.market || state.market;
    state.currency = event.currency || state.currency;
    state.name = event.name || state.name;

    if (event.kind === "acquire" || event.kind === "transfer_in") {
      state.quantity += event.quantity;
      state.costBasis += event.cost;
    } else if (event.kind === "buy") {
      state.quantity += event.quantity;
      state.costBasis += -event.cash;
    } else if (event.kind === "sell") {
      if (state.quantity + 1e-7 < event.quantity) {
        issues.push({
          id: `${event.date}-${event.code}-short-position`,
          severity: "warning",
          title: `${displayCode(event.code)} 卖出数量超过已追踪持仓`,
          detail: `卖出 ${event.quantity}，但当前只追踪到 ${state.quantity}。需要补充更早的买入或转入记录。`,
          source: event.source,
        });
      }
      const costBasis = event.quantity * stateAvgCost(state);
      const gainLoss = event.cash - costBasis;
      const trade: RealizedTrade = {
        id: `longbridge-${event.date}-${event.sequence}-${event.code}-${event.note}`,
        broker: "长桥",
        sellDate: event.date,
        market: event.market,
        currency: event.currency,
        symbol: displayCode(event.code),
        securityName: event.name,
        quantity: event.quantity,
        proceeds: event.cash,
        costBasis,
        gainLoss,
        source: event.source,
        note: event.note,
      };
      realizedTrades.push(trade);
      state.quantity -= event.quantity;
      state.costBasis -= costBasis;
      if (Math.abs(state.quantity) < 1e-8) {
        state.quantity = 0;
        state.costBasis = 0;
      }
    } else if (event.kind === "transfer_out") {
      const costBasis = event.quantity * stateAvgCost(state);
      state.quantity -= event.quantity;
      state.costBasis -= costBasis;
      if (Math.abs(state.quantity) < 1e-8) {
        state.quantity = 0;
        state.costBasis = 0;
      }
    }

    states.set(key, state);
  }

  return { trades: realizedTrades, issues, activities: buildTradeActivities(events) };
}

function buildOpenPositions(raw: LongbridgeRawData): OpenPosition[] {
  const latestByCode = new Map<string, PortfolioRecord>();
  for (const position of raw.positions) {
    const market = canonicalText(position.market);
    if (market !== "香港市场" && market !== "美国市场") continue;
    if (position.endQty <= 0) continue;
    latestByCode.set(`${position.currency}::${position.code}`, position);
  }

  return Array.from(latestByCode.values()).map((position) => ({
    id: `longbridge-open-${position.currency}-${position.code}`,
    broker: "长桥",
    asOf: position.sourcePdf.match(/2025(\d{2})/) ? `2025-${position.sourcePdf.match(/2025(\d{2})/)?.[1]}-末` : "",
    market: canonicalText(position.market),
    currency: position.currency,
    symbol: displayCode(position.code),
    securityName: position.name,
    quantity: position.endQty,
    marketValue: position.marketValue,
    costBasis: position.endQty * position.avgCost,
    unrealizedGainLoss: position.unrealizedGainLoss,
    source: position.sourcePdf,
  }));
}

export async function parseLongbridgePdfs(
  files: LongbridgeFileInput[],
  password?: string,
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: LongbridgeRawData = {
    trades: [],
    cashFlows: [],
    moves: [],
    positions: [],
    issues: [],
  };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data, password);
      const fileRaw = parseLongbridgeLines(file.name, lines);
      raw.trades.push(...fileRaw.trades);
      raw.cashFlows.push(...fileRaw.cashFlows);
      raw.moves.push(...fileRaw.moves);
      raw.positions.push(...fileRaw.positions);
      raw.issues.push(...fileRaw.issues);
    } catch (error) {
      raw.issues.push({
        id: `${file.name}-pdf-error`,
        severity: "blocking",
        title: "长桥PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。请确认密码是否正确。",
        source: file.name,
      });
    }
  }

  const realized = buildRealizedTrades(raw);
  parsed.realizedTrades.push(...realized.trades);
  parsed.tradeActivities.push(...realized.activities);
  parsed.dividends.push(...buildDividends(raw.cashFlows));
  parsed.openPositions.push(...buildOpenPositions(raw));
  parsed.issues.push(...raw.issues, ...realized.issues);

  if (raw.trades.length === 0 && files.length > 0) {
    parsed.issues.push({
      id: "longbridge-no-trades",
      severity: "warning",
      title: "未识别长桥股票交易",
      detail: "没有从上传的长桥PDF中识别到股票交易表。请确认文件是否为月结单且密码正确。",
    });
  }

  return parsed;
}
