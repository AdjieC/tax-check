import { emptyParsedInput } from "@/lib/tax/calculator";
import type {
  CostBasisRequest,
  DividendIncome,
  OpenPosition,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  TradeActivity,
} from "@/lib/tax/types";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { normalizeSymbol } from "./common";

interface SchwabFileInput {
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
  width: number;
}

interface TextLine {
  page: number;
  text: string;
  tokens: TextToken[];
}

interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

interface StatementPeriod {
  start: string;
  end: string;
  year: number;
}

interface TradeRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  settlementDate: string;
  tradeDate: string;
  side: "buy" | "sell";
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  fee: number;
  amount: number;
  reportedGainLoss?: number;
}

interface TransferRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  date: string;
  side: "transfer_in" | "transfer_out";
  symbol: string;
  securityName: string;
  quantity: number;
  statementValue: number;
}

interface IncomeRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  date: string;
  symbol: string;
  securityName: string;
  kind: "gross" | "tax";
  amount: number;
  description: string;
}

interface PositionRecord {
  sourcePdf: string;
  page: number;
  statementDate: string;
  symbol: string;
  securityName: string;
  quantity: number;
  closingPrice: number;
  marketValue: number;
  costBasis?: number;
  unrealizedGainLoss?: number;
}

interface SchwabFileData {
  period?: StatementPeriod;
  trades: TradeRecord[];
  transfers: TransferRecord[];
  incomes: IncomeRecord[];
  positions: PositionRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface MissingCostRecord {
  id: string;
  activityId: string;
  sellDate: string;
  sequence: number;
  symbol: string;
  securityName: string;
  quantity: number;
  trackedQuantity: number;
  proceeds: number;
  source: string;
}

const SCHWAB_BROKER = "嘉信";
const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value).normalize("NFKC").replaceAll("−", "-").replaceAll("–", "-");
}

function compactText(value: string) {
  return canonicalText(value).replace(/\s+/g, "");
}

function joinTokens(tokens: TextToken[]) {
  let value = "";
  let previous: TextToken | undefined;
  for (const token of [...tokens].sort((a, b) => a.x - b.x)) {
    if (previous && token.x - (previous.x + previous.width) > 1.5) value += " ";
    value += token.text;
    previous = token;
  }
  return clean(value);
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return joinTokens(line.tokens.filter((token) => token.x >= minX && token.x < maxX));
}

function maybeAmount(value: string): number | undefined {
  const text = canonicalText(value).replaceAll("$", "");
  const match = text.match(/\(?[+-]?\d[\d,]*(?:\.\d+)?\)?/);
  if (!match) return undefined;
  const token = match[0];
  const negative = token.startsWith("(") || token.startsWith("-");
  const amount = Number(token.replace(/[(),+\-]/g, ""));
  if (!Number.isFinite(amount)) return undefined;
  return negative ? -amount : amount;
}

function amount(value: string) {
  return maybeAmount(value) ?? 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shortDate(value: string, defaultYear: number) {
  const match = canonicalText(value).match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|20\d{2}))?$/);
  if (!match) return "";
  const rawYear = match[3];
  const year = rawYear ? (rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)) : defaultYear;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return isoDate(year, month, day);
}

function statementPeriod(lines: TextLine[]): StatementPeriod | undefined {
  for (const line of lines.slice(0, 80)) {
    const compact = canonicalText(line.text).replace(/\s+/g, "");
    const match = compact.match(
      /(January|February|March|April|May|June|July|August|September|October|November|December)(\d{1,2})-(\d{1,2}),?(20\d{2})/i,
    );
    if (!match) continue;
    const month = MONTHS[match[1].toLowerCase()];
    const year = Number(match[4]);
    return {
      start: isoDate(year, month, Number(match[2])),
      end: isoDate(year, month, Number(match[3])),
      year,
    };
  }
  return undefined;
}

function isSchwabStatement(lines: TextLine[]) {
  const text = canonicalText(lines.map((line) => line.text).join("\n")).toLowerCase();
  const compact = text.replace(/[^a-z0-9]/g, "");
  return (
    compact.includes("schwab") &&
    (compact.includes("transactiondetails") || compact.includes("positionssummary"))
  );
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
                width: Number(candidate.width ?? 0),
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
                text: joinTokens(sortedTokens),
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

function cleanSecurityName(value: string, symbol: string) {
  const name = canonicalText(value)
    .replace(/\(M\),?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || symbol;
}

function parsePositionLine(sourcePdf: string, line: TextLine, period: StatementPeriod): PositionRecord | null {
  const symbolText = canonicalText(lineCell(line, 0, 60));
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbolText) || symbolText === "SYMBOL") return null;
  const quantity = Math.abs(amount(lineCell(line, 285, 345)));
  const closingPrice = Math.abs(amount(lineCell(line, 345, 405)));
  const marketValue = Math.abs(amount(lineCell(line, 405, 490)));
  if (quantity <= 0 || marketValue <= 0) return null;
  const costBasis = maybeAmount(lineCell(line, 490, 555));
  const unrealizedGainLoss = maybeAmount(lineCell(line, 555, 635));
  const symbol = normalizeSymbol(symbolText);
  return {
    sourcePdf,
    page: line.page,
    statementDate: period.end,
    symbol,
    securityName: cleanSecurityName(lineCell(line, 60, 285), symbol),
    quantity,
    closingPrice,
    marketValue: roundMoney(marketValue),
    costBasis: costBasis === undefined ? undefined : roundMoney(Math.abs(costBasis)),
    unrealizedGainLoss: unrealizedGainLoss === undefined ? undefined : roundMoney(unrealizedGainLoss),
  };
}

function parseTradeLine(
  sourcePdf: string,
  line: TextLine,
  settlementDate: string,
  sequence: number,
): TradeRecord | null {
  const category = canonicalText(lineCell(line, 40, 95));
  const side = /^Purchase$/i.test(category) ? "buy" : /^Sale$/i.test(category) ? "sell" : null;
  if (!side || !settlementDate) return null;
  const symbolText = canonicalText(lineCell(line, 170, 248)).split(/\s+/)[0] ?? "";
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbolText)) return null;
  const symbol = normalizeSymbol(symbolText);
  const quantity = Math.abs(amount(lineCell(line, 440, 510)));
  const unitPrice = Math.abs(amount(lineCell(line, 510, 575)));
  const netAmount = Math.abs(amount(lineCell(line, 635, 720)));
  if (quantity <= 0 || unitPrice <= 0 || netAmount <= 0) return null;
  const calculatedGross = roundMoney(quantity * unitPrice);
  const statedFee = Math.abs(amount(lineCell(line, 575, 635)));
  const feeFromNet = side === "buy" ? netAmount - calculatedGross : calculatedGross - netAmount;
  const fee = roundMoney(feeFromNet >= -0.02 ? Math.max(0, feeFromNet) : statedFee);
  const reportedGainLoss = side === "sell" ? maybeAmount(lineCell(line, 720, 792)) : undefined;
  return {
    sourcePdf,
    page: line.page,
    sequence,
    settlementDate,
    tradeDate: settlementDate,
    side,
    symbol,
    securityName: cleanSecurityName(lineCell(line, 248, 440), symbol),
    quantity,
    unitPrice,
    grossAmount: calculatedGross,
    fee,
    amount: roundMoney(netAmount),
    reportedGainLoss: reportedGainLoss === undefined ? undefined : roundMoney(reportedGainLoss),
  };
}

function parseTransferLine(
  sourcePdf: string,
  line: TextLine,
  date: string,
  sequence: number,
): TransferRecord | null {
  const category = canonicalText(lineCell(line, 40, 95));
  const action = canonicalText(lineCell(line, 95, 175));
  if (!/^Other$/i.test(category) || !/Journaled\s+Shares/i.test(action) || !date) return null;
  const symbolText = canonicalText(lineCell(line, 170, 248)).split(/\s+/)[0] ?? "";
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbolText)) return null;
  const rawQuantity = amount(lineCell(line, 440, 510));
  if (!rawQuantity) return null;
  const symbol = normalizeSymbol(symbolText);
  return {
    sourcePdf,
    page: line.page,
    sequence,
    date,
    side: rawQuantity < 0 ? "transfer_out" : "transfer_in",
    symbol,
    securityName: cleanSecurityName(lineCell(line, 248, 440), symbol),
    quantity: Math.abs(rawQuantity),
    statementValue: roundMoney(Math.abs(amount(lineCell(line, 635, 720)))),
  };
}

function parseIncomeLine(
  sourcePdf: string,
  line: TextLine,
  date: string,
  sequence: number,
): IncomeRecord | null {
  const category = canonicalText(lineCell(line, 40, 95));
  if (!/Dividend|Interest/i.test(category) || !date) return null;
  const action = canonicalText(lineCell(line, 95, 175));
  const rowAmount = maybeAmount(lineCell(line, 635, 720));
  if (rowAmount === undefined || Math.abs(rowAmount) <= 0) return null;
  const symbolText = canonicalText(lineCell(line, 170, 248)).split(/\s+/)[0] ?? "";
  const fallbackSymbol = /Interest/i.test(category) ? "CASH-INTEREST" : "CASH-DIVIDEND";
  const symbol = /^[A-Z][A-Z0-9.-]{0,11}$/.test(symbolText) ? normalizeSymbol(symbolText) : fallbackSymbol;
  const isTax = /NRA\s*Tax|Withholding\s*Tax|Tax\s*Withheld/i.test(action) || rowAmount < 0;
  return {
    sourcePdf,
    page: line.page,
    sequence,
    date,
    symbol,
    securityName: cleanSecurityName(lineCell(line, 248, 440), symbol),
    kind: isTax ? "tax" : "gross",
    amount: roundMoney(Math.abs(rowAmount)),
    description: clean(`${category} ${action}`),
  };
}

function parseSchwabLines(sourcePdf: string, lines: TextLine[], baseSequence: number): SchwabFileData {
  const period = statementPeriod(lines);
  const raw: SchwabFileData = {
    period,
    trades: [],
    transfers: [],
    incomes: [],
    positions: [],
    issues: [],
    statementDetected: isSchwabStatement(lines),
  };
  let activePositions = false;
  let activeTransactions = false;
  let settlementDate = "";
  let lastTrade: TradeRecord | null = null;
  let sequence = baseSequence;

  for (const line of lines) {
    const text = canonicalText(line.text);
    const compact = compactText(text).toLowerCase();

    if (/^positions-(equities|exchangetradedfunds)/i.test(compact)) {
      activePositions = true;
      activeTransactions = false;
      continue;
    }
    if (compact.startsWith("transactions-summary") || compact.startsWith("cashandcashinvestments")) {
      activePositions = false;
    }
    if (compact.startsWith("transactiondetails")) {
      activeTransactions = true;
      activePositions = false;
      lastTrade = null;
      continue;
    }
    if (compact.startsWith("totaltransactions") || compact.startsWith("pending/openactivity")) {
      activeTransactions = false;
      lastTrade = null;
      continue;
    }

    if (activePositions && period) {
      const position = parsePositionLine(sourcePdf, line, period);
      if (position) raw.positions.push(position);
      continue;
    }
    if (!activeTransactions || !period) continue;

    const dateCell = lineCell(line, 0, 40);
    const rowDate = shortDate(dateCell, period.year);
    if (rowDate) settlementDate = rowDate;

    const tradeDateMatch = compact.match(/tradedate:(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (tradeDateMatch && lastTrade) {
      lastTrade.tradeDate = shortDate(tradeDateMatch[1], period.year) || lastTrade.settlementDate;
      continue;
    }

    const trade = parseTradeLine(sourcePdf, line, settlementDate, sequence);
    if (trade) {
      raw.trades.push(trade);
      lastTrade = trade;
      sequence += 1;
      continue;
    }
    lastTrade = null;

    const transfer = parseTransferLine(sourcePdf, line, settlementDate, sequence);
    if (transfer) {
      raw.transfers.push(transfer);
      sequence += 1;
      continue;
    }
    const income = parseIncomeLine(sourcePdf, line, settlementDate, sequence);
    if (income) {
      raw.incomes.push(income);
      sequence += 1;
    }
  }

  if (raw.statementDetected && !period) {
    raw.issues.push({
      id: `schwab-${sourcePdf}-missing-period`,
      severity: "blocking",
      title: "未识别嘉信月结单期间",
      detail: "无法读取 Statement Period，交易和期末持仓不能安全归入纳税年度。",
      source: sourcePdf,
    });
  }
  return raw;
}

function activityFromTrade(trade: TradeRecord): TradeActivity {
  return {
    id: `schwab-activity-${trade.tradeDate}-${trade.sequence}-${trade.symbol}-${trade.side}`,
    broker: SCHWAB_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: "美国市场",
    currency: "USD",
    symbol: trade.symbol,
    securityName: trade.securityName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: trade.grossAmount,
    fee: trade.fee,
    amount: trade.amount,
    source: `${trade.sourcePdf}#p${trade.page}`,
    note: `嘉信月结单股票交易；结算日期 ${trade.settlementDate}${
      trade.reportedGainLoss === undefined ? "" : `；券商已实现盈亏 ${trade.reportedGainLoss.toFixed(2)}`
    }`,
  };
}

function activityFromTransfer(transfer: TransferRecord): TradeActivity {
  const isTransferIn = transfer.side === "transfer_in";
  return {
    id: `schwab-transfer-${transfer.date}-${transfer.sequence}-${transfer.symbol}-${transfer.side}`,
    broker: SCHWAB_BROKER,
    date: transfer.date,
    sequence: transfer.sequence,
    market: "美国市场",
    currency: "USD",
    symbol: transfer.symbol,
    securityName: transfer.securityName,
    side: transfer.side,
    quantity: transfer.quantity,
    amount: 0,
    source: `${transfer.sourcePdf}#p${transfer.page}`,
    note: `嘉信月结单 Journaled Shares；结单所列 USD ${transfer.statementValue.toFixed(
      2,
    )} 是转入/转出时点市值，不是原始成本${isTransferIn ? "；可在持仓流水中手动订正转入成本" : ""}`,
    excludedFromTaxReplay: isTransferIn,
  };
}

function reportedTrade(trade: TradeRecord): RealizedTrade | null {
  if (trade.side !== "sell" || trade.reportedGainLoss === undefined) return null;
  return {
    id: `schwab-reported-${trade.tradeDate}-${trade.sequence}-${trade.symbol}`,
    broker: SCHWAB_BROKER,
    sellDate: trade.tradeDate,
    sequence: trade.sequence,
    market: "美国市场",
    currency: "USD",
    symbol: trade.symbol,
    securityName: trade.securityName,
    quantity: trade.quantity,
    proceeds: trade.amount,
    costBasis: roundMoney(trade.amount - trade.reportedGainLoss),
    gainLoss: trade.reportedGainLoss,
    source: `${trade.sourcePdf}#p${trade.page}`,
    note: "使用嘉信月结单 Realized Gain/(Loss) 列；可在盈亏明细中订正成本",
    useBrokerReportedGainLoss: true,
  };
}

function dividendsFromIncome(records: IncomeRecord[]): DividendIncome[] {
  const groups = new Map<
    string,
    {
      date: string;
      symbol: string;
      securityName: string;
      grossAmount: number;
      taxWithheld: number;
      sourcePdf: string;
      page: number;
      descriptions: Set<string>;
    }
  >();
  for (const record of records) {
    const key = `${record.date}::${record.symbol}`;
    const group =
      groups.get(key) ??
      ({
        date: record.date,
        symbol: record.symbol,
        securityName: record.securityName,
        grossAmount: 0,
        taxWithheld: 0,
        sourcePdf: record.sourcePdf,
        page: record.page,
        descriptions: new Set<string>(),
      } satisfies {
        date: string;
        symbol: string;
        securityName: string;
        grossAmount: number;
        taxWithheld: number;
        sourcePdf: string;
        page: number;
        descriptions: Set<string>;
      });
    if (record.kind === "tax") group.taxWithheld += record.amount;
    else group.grossAmount += record.amount;
    group.descriptions.add(record.description);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter((group) => group.grossAmount > 0)
    .map((group) => ({
      id: `schwab-dividend-${group.date}-${group.symbol}`,
      broker: SCHWAB_BROKER,
      date: group.date,
      currency: "USD",
      symbol: group.symbol,
      securityName: group.securityName,
      grossAmount: roundMoney(group.grossAmount),
      taxWithheld: roundMoney(group.taxWithheld),
      fee: 0,
      source: `${group.sourcePdf}#p${group.page}`,
      note: `嘉信月结单 ${Array.from(group.descriptions).join(" / ")}`,
      evidence: {
        page: group.page,
        text: `${group.date} ${group.symbol} ${Array.from(group.descriptions).join(" / ")}`,
      },
    }));
}

function openPosition(position: PositionRecord): OpenPosition {
  return {
    id: `schwab-open-${position.statementDate}-${position.symbol}`,
    broker: SCHWAB_BROKER,
    asOf: position.statementDate,
    market: "美国市场",
    currency: "USD",
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    costBasis: position.costBasis,
    unrealizedGainLoss: position.unrealizedGainLoss,
    source: `${position.sourcePdf}#p${position.page}`,
    note: `嘉信月末持仓；收市价 ${position.closingPrice.toFixed(5)}，未实现盈亏不计入资本利得。`,
  };
}

function latestPositions(positions: PositionRecord[]) {
  const latest = new Map<string, PositionRecord>();
  for (const position of positions) {
    const existing = latest.get(position.symbol);
    if (!existing || position.statementDate >= existing.statementDate) latest.set(position.symbol, position);
  }
  return Array.from(latest.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function sortedActivities(activities: TradeActivity[]) {
  return [...activities].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0),
  );
}

function missingCostRecords(activities: TradeActivity[], reportedIds: Set<string>, targetYear?: number) {
  const lots = new Map<string, Array<{ quantity: number; known: boolean }>>();
  const missing: MissingCostRecord[] = [];
  for (const activity of sortedActivities(activities)) {
    const key = activity.symbol;
    const securityLots = lots.get(key) ?? [];
    if (activity.side === "buy" || activity.side === "acquire") {
      securityLots.push({ quantity: activity.quantity, known: true });
      lots.set(key, securityLots);
      continue;
    }
    if (activity.side === "transfer_in") {
      securityLots.push({ quantity: activity.quantity, known: false });
      lots.set(key, securityLots);
      continue;
    }
    if (activity.side !== "sell" && activity.side !== "transfer_out") continue;

    let remaining = activity.quantity;
    let unknownQuantity = 0;
    let trackedQuantity = 0;
    while (remaining > 1e-8 && securityLots.length > 0) {
      const lot = securityLots[0];
      const used = Math.min(lot.quantity, remaining);
      trackedQuantity += used;
      if (!lot.known) unknownQuantity += used;
      lot.quantity -= used;
      remaining -= used;
      if (lot.quantity <= 1e-8) securityLots.shift();
    }
    lots.set(key, securityLots);
    if (activity.side !== "sell" || reportedIds.has(activity.id)) continue;
    if (remaining <= 1e-8 && unknownQuantity <= 1e-8) continue;
    if (targetYear !== undefined && !activity.date.startsWith(String(targetYear))) continue;
    missing.push({
      id: `schwab-cost-${targetYear ?? "unknown"}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`,
      activityId: activity.id,
      sellDate: activity.date,
      sequence: activity.sequence ?? 0,
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

function manualCostData(records: MissingCostRecord[], manualCosts: ManualCostInput[]) {
  const costMap = new Map(
    manualCosts
      .filter((item) => item.id && Number.isFinite(item.costBasis) && item.costBasis >= 0)
      .map((item) => [item.id, item.costBasis]),
  );
  const realizedTrades: RealizedTrade[] = [];
  const requests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];
  for (const record of records) {
    const manualCost = costMap.get(record.id);
    if (manualCost !== undefined) {
      realizedTrades.push({
        id: `${record.id}-manual`,
        broker: SCHWAB_BROKER,
        sellDate: record.sellDate,
        sequence: record.sequence,
        market: "美国市场",
        currency: "USD",
        symbol: record.symbol,
        securityName: record.securityName,
        quantity: record.quantity,
        proceeds: record.proceeds,
        costBasis: roundMoney(manualCost),
        gainLoss: roundMoney(record.proceeds - manualCost),
        source: record.source,
        note: "用户手动补录这笔嘉信卖出总成本",
        useBrokerReportedGainLoss: true,
      });
      continue;
    }
    requests.push({
      id: record.id,
      broker: SCHWAB_BROKER,
      sellDate: record.sellDate,
      sequence: record.sequence,
      market: "美国市场",
      currency: "USD",
      symbol: record.symbol,
      securityName: record.securityName,
      quantity: record.quantity,
      trackedQuantity: record.trackedQuantity,
      proceeds: record.proceeds,
      source: record.source,
      note: "嘉信月结单未提供这笔卖出的已实现盈亏，需补录总成本后计入",
    });
    issues.push({
      id: `${record.id}-cost-gap`,
      severity: "warning",
      title: `${record.symbol} 历史成本缺失`,
      detail: `${record.sellDate} 卖出 ${record.quantity} 股，但嘉信月结单没有可用的 Realized Gain/(Loss)，上传材料也不足以重放完整成本。请补充历史材料或手动填写总成本。`,
      source: record.source,
    });
  }
  return { realizedTrades, requests, issues };
}

function aggregateIssue(
  files: SchwabFileData[],
  trades: TradeRecord[],
  transfers: TransferRecord[],
  dividends: DividendIncome[],
  positions: PositionRecord[],
): ReviewIssue {
  const buys = trades.filter((trade) => trade.side === "buy").length;
  const sells = trades.filter((trade) => trade.side === "sell");
  const reported = sells.filter((trade) => trade.reportedGainLoss !== undefined);
  const reportedGainLoss = reported.reduce((sum, trade) => sum + (trade.reportedGainLoss ?? 0), 0);
  const sources = Array.from(
    new Set(
      files.flatMap((file) => [
        ...file.trades.map((item) => item.sourcePdf),
        ...file.transfers.map((item) => item.sourcePdf),
        ...file.positions.map((item) => item.sourcePdf),
      ]),
    ),
  );
  return {
    id: `schwab-${sources.join("-")}-parsed`,
    severity: "info",
    title: "已解析嘉信月结单",
    detail: `已读取 ${sources.length} 份月结单：买入 ${buys} 笔、卖出 ${sells.length} 笔、证券转入/转出 ${transfers.length} 条、分红/利息 ${dividends.length} 条、期末持仓 ${positions.length} 条。${reported.length} 笔卖出采用嘉信 Realized Gain/(Loss)，合计 USD ${reportedGainLoss.toFixed(2)}；Journaled Shares 的金额按转仓时点市值展示，不当作原始成本。`,
    source: sources[0],
  };
}

export async function parseSchwabPdfs(
  files: SchwabFileInput[],
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const fileData: SchwabFileData[] = [];

  for (const [fileIndex, file] of files.entries()) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      fileData.push(parseSchwabLines(file.name, lines, fileIndex * 100000));
    } catch (error) {
      parsed.issues.push({
        id: `schwab-${file.name}-pdf-error`,
        severity: "blocking",
        title: "嘉信 PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  if (!fileData.some((item) => item.statementDetected)) {
    parsed.issues.push({
      id: "schwab-unsupported-statement",
      severity: "blocking",
      title: "嘉信文件格式不符合要求",
      detail: "当前没有识别到 Charles Schwab Brokerage Statement 月结单特征，请确认券商选择和 PDF 文件。",
      source: files[0]?.name,
    });
    return parsed;
  }

  const trades = fileData.flatMap((item) => item.trades);
  const transfers = fileData.flatMap((item) => item.transfers);
  const incomes = fileData.flatMap((item) => item.incomes);
  const positions = fileData.flatMap((item) => item.positions);
  let activities = sortedActivities([
    ...trades.map(activityFromTrade),
    ...transfers.map(activityFromTransfer),
  ]);
  const reportedTrades = trades.map(reportedTrade).filter((item): item is RealizedTrade => item !== null);
  const reportedActivityIds = new Set(
    trades
      .filter((trade) => trade.side === "sell" && trade.reportedGainLoss !== undefined)
      .map((trade) => `schwab-activity-${trade.tradeDate}-${trade.sequence}-${trade.symbol}-${trade.side}`),
  );
  const missingRecords = missingCostRecords(activities, reportedActivityIds, options.targetYear);
  const missingActivityIds = new Set(missingRecords.map((item) => item.activityId));
  activities = activities.map((activity) =>
    missingActivityIds.has(activity.id) ? { ...activity, excludedFromTaxReplay: true } : activity,
  );
  const missing = manualCostData(missingRecords, options.manualCosts ?? []);
  const dividends = dividendsFromIncome(incomes);
  const latest = latestPositions(positions);

  parsed.tradeActivities.push(...activities);
  parsed.realizedTrades.push(...reportedTrades, ...missing.realizedTrades);
  parsed.dividends.push(...dividends);
  parsed.openPositions.push(...latest.map(openPosition));
  parsed.costBasisRequests.push(...missing.requests);
  parsed.issues.push(...fileData.flatMap((item) => item.issues), ...missing.issues);
  if (trades.length > 0 || transfers.length > 0 || dividends.length > 0 || positions.length > 0) {
    parsed.issues.push(aggregateIssue(fileData, trades, transfers, dividends, latest));
  } else {
    parsed.issues.push({
      id: "schwab-empty-statement",
      severity: "info",
      title: "本月没有嘉信证券活动",
      detail: "已识别为嘉信月结单，但没有读取到股票交易、分红/利息、证券转仓或期末证券持仓。",
      source: files[0]?.name,
    });
  }
  return parsed;
}
