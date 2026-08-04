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

interface FangdeFileInput {
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
  refNo: string;
  tradeDate: string;
  settleDate: string;
  side: "buy" | "sell";
  currency: Currency;
  market: string;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  fee: number;
  amount: number;
  forcedSale: boolean;
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

interface MovementRecord {
  sourcePdf: string;
  page: number;
  sequence: number;
  refNo: string;
  settleDate: string;
  tradeDate: string;
  currency: Currency;
  description: string;
  amount: number;
}

interface FangdeRawData {
  trades: TradeRecord[];
  positions: PositionRecord[];
  movements: MovementRecord[];
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

const FANGDE_BROKER = "方德";
const NUMBER_PATTERN = /^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/;
const DATE_PATTERN = /^(20\d{2})-(\d{2})-(\d{2})$/;

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("戶", "户")
    .replaceAll("帳", "账")
    .replaceAll("賬", "账")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("證", "证")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("費", "费")
    .replaceAll("幣", "币")
    .replaceAll("價", "价")
    .replaceAll("數", "数")
    .replaceAll("額", "额")
    .replaceAll("淨", "净")
    .replaceAll("－", "-")
    .replaceAll("−", "-");
}

function compactText(value: string) {
  return canonicalText(value).replace(/\s+/g, "");
}

function parseNumber(value: string) {
  const normalized = canonicalText(value).replace(/,/g, "").replace(/[()]/g, "").replace(/[^0-9.+-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseAmount(value: string) {
  const text = canonicalText(value).trim();
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const amount = Math.abs(parseNumber(text));
  return negative ? -amount : amount;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeDate(value: string) {
  const text = canonicalText(value);
  const iso = text.match(DATE_PATTERN);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = text.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(20\d{2})$/);
  if (!slash) return "";
  return `${slash[3]}-${String(Number(slash[2])).padStart(2, "0")}-${String(Number(slash[1])).padStart(2, "0")}`;
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
    (token) => token.x >= minX && token.x < maxX && NUMBER_PATTERN.test(canonicalText(token.text)),
  );
}

function tradeSide(value: string): "buy" | "sell" | null {
  const text = canonicalText(value).toLowerCase();
  if (/沽出|卖出|\bsell\b/.test(text)) return "sell";
  if (/买入|\bbuy\b/.test(text)) return "buy";
  return null;
}

function marketForProduct(value: string) {
  const text = canonicalText(value).toUpperCase();
  const match = text.match(/^([A-Z0-9.-]+)\s*:\s*([A-Z]{2,})$/);
  if (!match) return null;
  const suffix = match[2];
  if (["US", "NYSE", "NASDAQ", "AMEX"].includes(suffix)) {
    return { symbol: normalizeSymbol(match[1]), currency: "USD" as Currency, market: "美国市场" };
  }
  if (["SH", "SZ", "CN"].includes(suffix)) {
    return { symbol: normalizeSymbol(match[1]), currency: "CNY" as Currency, market: "A股通" };
  }
  return { symbol: normalizeSymbol(match[1]), currency: "HKD" as Currency, market: "香港市场" };
}

function positionMarket(value: string) {
  const text = canonicalText(value).toUpperCase();
  if (/美交所|美国|NASDAQ|NYSE|AMEX|US MARKET/.test(text)) {
    return { currency: "USD" as Currency, market: "美国市场" };
  }
  if (/沪股|深股|A股|SHANGHAI|SHENZHEN/.test(text)) {
    return { currency: "CNY" as Currency, market: "A股通" };
  }
  if (/港交所|香港|HKEX|HONG KONG/.test(text)) {
    return { currency: "HKD" as Currency, market: "香港市场" };
  }
  return null;
}

function isFangdeStatement(lines: TextLine[]) {
  const text = canonicalText(lines.map((line) => line.text).join("\n"));
  const lower = text.toLowerCase();
  return (
    text.includes("方德证券有限公司") ||
    lower.includes("forthright securities company limited") ||
    (text.includes("综合成交单据及账户月结单") && lower.includes("combined monthly statement"))
  );
}

function statementDateFromLines(lines: TextLine[]) {
  for (const line of lines.slice(0, 30)) {
    const text = canonicalText(line.text);
    if (!/Print Date|列印于/i.test(text)) continue;
    const match = text.match(/(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*20\d{2})/);
    const date = match ? normalizeDate(match[1]) : "";
    if (date) return date;
  }
  const heading = compactText(lines.slice(0, 20).map((line) => line.text).join(" "));
  const month = heading.match(/月结单\((20\d{2})(0[1-9]|1[0-2])\)/);
  if (!month) return "";
  const lastDay = new Date(Number(month[1]), Number(month[2]), 0).getDate();
  return `${month[1]}-${month[2]}-${String(lastDay).padStart(2, "0")}`;
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

function securityNameNearTrade(lines: TextLine[], index: number, symbol: string) {
  const page = lines[index].page;
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate || candidate.page !== page) break;
    const value = canonicalText(lineCell(candidate, 180, 305));
    if (!value || normalizeDate(value) || marketForProduct(value) || tradeSide(value)) continue;
    if (/^(Product|产品|Price|价格)$/i.test(value)) continue;
    return value;
  }
  return symbol;
}

function settlementDateNearTrade(lines: TextLine[], index: number, tradeDate: string) {
  const page = lines[index].page;
  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate || candidate.page !== page) break;
    const date = normalizeDate(lineCell(candidate, 75, 155));
    if (date && date !== tradeDate) return date;
  }
  return "";
}

function netAmountNearTrade(lines: TextLine[], index: number) {
  const page = lines[index].page;
  for (let offset = 1; offset <= 2; offset += 1) {
    const candidate = lines[index + offset];
    if (!candidate || candidate.page !== page) break;
    const token = numericTokens(candidate, 520)[0];
    if (token) return Math.abs(parseAmount(token.text));
  }
  return 0;
}

function parseTradeLine(sourcePdf: string, lines: TextLine[], index: number, sequence: number): TradeRecord | null {
  const line = lines[index];
  const tradeDateToken = line.tokens.find((token) => normalizeDate(token.text));
  const side = tradeSide(line.text);
  const productToken = line.tokens.find((token) => marketForProduct(token.text));
  if (!tradeDateToken || !side || !productToken) return null;
  const tradeDate = normalizeDate(tradeDateToken.text);
  const security = marketForProduct(productToken.text);
  if (!security) return null;

  const refNo =
    line.tokens.find((token) => token.x < tradeDateToken.x && /^\d{5,}$/.test(canonicalText(token.text)))?.text ?? "";
  const productIndex = line.tokens.indexOf(productToken);
  const values = line.tokens
    .slice(productIndex + 1)
    .filter((token) => NUMBER_PATTERN.test(canonicalText(token.text)));
  if (!refNo || values.length < 4) return null;
  const unitPrice = Math.abs(parseNumber(values[0].text));
  const quantity = Math.abs(parseAmount(values[1].text));
  const grossAmount = roundMoney(Math.abs(parseAmount(values[2].text)));
  const firstFee = Math.abs(parseAmount(values[3].text));
  const netAmount = roundMoney(netAmountNearTrade(lines, index));
  const calculatedGross = roundMoney(unitPrice * quantity);
  if (unitPrice <= 0 || quantity <= 0 || grossAmount <= 0 || Math.abs(calculatedGross - grossAmount) > 0.02) return null;

  const feeFromNet = side === "buy" ? netAmount - grossAmount : grossAmount - netAmount;
  const fee = roundMoney(feeFromNet >= -0.02 ? Math.max(0, feeFromNet) : firstFee);
  const amount = netAmount > 0 ? netAmount : roundMoney(side === "buy" ? grossAmount + fee : grossAmount - fee);
  if (amount <= 0) return null;

  return {
    sourcePdf,
    page: line.page,
    sequence,
    refNo: canonicalText(refNo),
    tradeDate,
    settleDate: settlementDateNearTrade(lines, index, tradeDate),
    side,
    currency: security.currency,
    market: security.market,
    symbol: security.symbol,
    securityName: securityNameNearTrade(lines, index, security.symbol),
    quantity,
    unitPrice,
    grossAmount,
    fee,
    amount,
    forcedSale: line.tokens.some((token) => token.x < 25 && canonicalText(token.text) === "#"),
  };
}

function parseMovementLine(sourcePdf: string, line: TextLine, sequence: number, currency: Currency): MovementRecord | null {
  const dateTokens = line.tokens.filter((token) => normalizeDate(token.text));
  if (dateTokens.length < 2) return null;
  const refNo = line.tokens.find((token) => token.x < 78 && /^\d{5,}$/.test(canonicalText(token.text)))?.text ?? "";
  const amountToken = numericTokens(line, 430, 525)[0];
  if (!refNo || !amountToken) return null;
  const description = canonicalText(lineCell(line, 180, 430));
  return {
    sourcePdf,
    page: line.page,
    sequence,
    refNo: canonicalText(refNo),
    settleDate: normalizeDate(dateTokens[0].text),
    tradeDate: normalizeDate(dateTokens[1].text),
    currency,
    description,
    amount: parseAmount(amountToken.text),
  };
}

function parsePositionLine(
  sourcePdf: string,
  line: TextLine,
  statementDate: string,
  positionCurrency: Currency,
  positionMarketName: string,
): PositionRecord | null {
  if (!statementDate) return null;
  const symbolToken = line.tokens.find((token) => token.x < 75 && /^[A-Z0-9.-]{2,}$/.test(canonicalText(token.text).toUpperCase()));
  const name = canonicalText(lineCell(line, 75, 175));
  const values = numericTokens(line, 175);
  if (!symbolToken || !name || values.length < 5) return null;
  const quantity = parseAmount(values[2].text);
  const closingPrice = Math.abs(parseNumber(values[3].text));
  const marketValue = Math.abs(parseAmount(values[4].text));
  if (quantity <= 0 || closingPrice <= 0 || marketValue < 0) return null;
  return {
    sourcePdf,
    page: line.page,
    statementDate,
    currency: positionCurrency,
    market: positionMarketName,
    symbol: normalizeSymbol(symbolToken.text),
    securityName: name,
    quantity,
    closingPrice,
    marketValue,
  };
}

function parseFangdeLines(sourcePdf: string, lines: TextLine[], baseSequence: number): FangdeRawData {
  const statementDate = statementDateFromLines(lines);
  const raw: FangdeRawData = {
    trades: [],
    positions: [],
    movements: [],
    issues: [],
    statementDetected: isFangdeStatement(lines),
  };
  let activeTable: "none" | "trades" | "movements" | "positions" = "none";
  let positionCurrency: Currency = "HKD";
  let positionMarketName = "香港市场";
  let sequence = baseSequence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = canonicalText(line.text);
    const compact = compactText(text);

    if (compact.includes("DailyTrades成交单据")) {
      activeTable = "trades";
      continue;
    }
    if (compact.includes("AccountMovement户口变动")) {
      activeTable = "movements";
      continue;
    }
    if (compact.includes("Stock/ProductPosition持货结存")) {
      activeTable = "positions";
      continue;
    }
    if (/^(声明|重要提示|Address:|账户名称)/.test(text) && line.page > 1) activeTable = "none";

    if (activeTable === "trades") {
      const candidate = Boolean(line.tokens.find((token) => normalizeDate(token.text)) && tradeSide(text) && line.tokens.find((token) => marketForProduct(token.text)));
      if (!candidate) continue;
      const trade = parseTradeLine(sourcePdf, lines, index, sequence);
      if (!trade) {
        raw.issues.push({
          id: `fangde-${sourcePdf}-trade-row-${line.page}-${index}`,
          severity: "blocking",
          title: "方德成交记录解析失败",
          detail: `第 ${line.page} 页有一行成交记录未能通过价格、数量、金额和净额校验：${text}`,
          source: sourcePdf,
        });
        continue;
      }
      raw.trades.push(trade);
      sequence += 1;
      continue;
    }

    if (activeTable === "movements") {
      const movement = parseMovementLine(sourcePdf, line, sequence, "HKD");
      if (movement) {
        raw.movements.push(movement);
        sequence += 1;
      }
      continue;
    }

    if (activeTable === "positions") {
      const market = positionMarket(text);
      if (market) {
        positionCurrency = market.currency;
        positionMarketName = market.market;
        continue;
      }
      const position = parsePositionLine(sourcePdf, line, statementDate, positionCurrency, positionMarketName);
      if (position) raw.positions.push(position);
    }
  }

  if (raw.statementDetected && !statementDate) {
    raw.issues.push({
      id: `fangde-${sourcePdf}-missing-statement-date`,
      severity: "blocking",
      title: "未识别方德月结单日期",
      detail: "无法读取月结单列印日期或结单月份，交易和期末持仓不能安全归入纳税年度。",
      source: sourcePdf,
    });
  }

  const movementTrades = new Map(
    raw.movements
      .filter((movement) => tradeSide(movement.description))
      .map((movement) => [movement.refNo, Math.abs(movement.amount)]),
  );
  const mismatches = raw.trades.filter((trade) => {
    const movementAmount = movementTrades.get(trade.refNo);
    return movementAmount !== undefined && Math.abs(movementAmount - trade.amount) > 0.02;
  });
  if (mismatches.length > 0) {
    raw.issues.push({
      id: `fangde-${sourcePdf}-trade-movement-mismatch`,
      severity: "blocking",
      title: "方德成交单据与户口变动核对不一致",
      detail: mismatches
        .map((trade) => `参考编号 ${trade.refNo} 成交净额为 ${trade.amount.toFixed(2)}，户口变动为 ${Number(movementTrades.get(trade.refNo)).toFixed(2)}`)
        .join("；"),
      source: sourcePdf,
    });
  }
  return raw;
}

function activityFromTrade(trade: TradeRecord): TradeActivity {
  return {
    id: `fangde-activity-${trade.tradeDate}-${trade.sequence}-${trade.currency}-${trade.symbol}-${trade.side}`,
    broker: FANGDE_BROKER,
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
    fee: trade.fee,
    amount: trade.amount,
    source: trade.sourcePdf,
    note: `参考编号 ${trade.refNo}${trade.settleDate ? `；交收日期 ${trade.settleDate}` : ""}${trade.forcedSale ? "；月结单标记为强制出售" : ""}；方德月结单第 ${trade.page} 页`,
  };
}

function openPositionFromRecord(position: PositionRecord): OpenPosition {
  return {
    id: `fangde-open-${position.statementDate}-${position.currency}-${position.symbol}`,
    broker: FANGDE_BROKER,
    asOf: position.statementDate,
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    source: position.sourcePdf,
    note: `方德月末净结余持仓；收市价 ${position.closingPrice.toFixed(6)}，未实现盈亏不计入资本利得。`,
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

function dividendSymbol(description: string) {
  const match = canonicalText(description).match(/(?:^|[^\d])(\d{4,5})(?:[^\d]|$)/);
  return match ? normalizeSymbol(match[1]) : "CASH-DIVIDEND";
}

function dividendsFromMovements(movements: MovementRecord[]): DividendIncome[] {
  const aggregates = new Map<
    string,
    { date: string; currency: Currency; symbol: string; grossAmount: number; taxWithheld: number; fee: number; source: string; page: number; note: string }
  >();
  for (const movement of movements) {
    const description = canonicalText(movement.description);
    const dividend = /股息|红利|派息|dividend/i.test(description);
    const tax = /预扣税|股息税|withholding\s*tax/i.test(description);
    if (!dividend && !tax) continue;
    const symbol = dividendSymbol(description);
    const key = `${movement.tradeDate}::${movement.currency}::${symbol}`;
    const aggregate =
      aggregates.get(key) ??
      ({
        date: movement.tradeDate,
        currency: movement.currency,
        symbol,
        grossAmount: 0,
        taxWithheld: 0,
        fee: 0,
        source: movement.sourcePdf,
        page: movement.page,
        note: description,
      } satisfies { date: string; currency: Currency; symbol: string; grossAmount: number; taxWithheld: number; fee: number; source: string; page: number; note: string });
    if (tax) aggregate.taxWithheld += Math.abs(movement.amount);
    else if (/费用|手续费|fee/i.test(description)) aggregate.fee += Math.abs(movement.amount);
    else if (movement.amount > 0) aggregate.grossAmount += movement.amount;
    aggregates.set(key, aggregate);
  }
  return Array.from(aggregates.values())
    .filter((item) => item.grossAmount > 0)
    .map((item) => ({
      id: `fangde-dividend-${item.date}-${item.currency}-${item.symbol}`,
      broker: FANGDE_BROKER,
      date: item.date,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.symbol === "CASH-DIVIDEND" ? "方德现金股息" : item.symbol,
      grossAmount: roundMoney(item.grossAmount),
      taxWithheld: roundMoney(item.taxWithheld),
      fee: roundMoney(item.fee),
      source: item.source,
      note: item.note,
      evidence: { page: item.page, text: item.note },
    }));
}

function sortActivities(activities: TradeActivity[]) {
  return [...activities].sort((a, b) => a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0));
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
      id: `fangde-cost-${targetYear ?? "unknown"}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`,
      sellDate: activity.date,
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
        broker: FANGDE_BROKER,
        sellDate: item.sellDate,
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
      broker: FANGDE_BROKER,
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
      detail: `${item.sellDate} 卖出 ${item.quantity} 股，但上传的方德月结单没有足够的历史买入记录匹配成本。请补充更早月份月结单，或在待补成本中填写这笔卖出的总成本。`,
      source: item.source,
    });
  }
  return { realizedTrades, requests, issues };
}

function aggregateIssue(raw: FangdeRawData): ReviewIssue {
  const sources = Array.from(
    new Set([
      ...raw.trades.map((trade) => trade.sourcePdf),
      ...raw.positions.map((position) => position.sourcePdf),
      ...raw.movements.map((movement) => movement.sourcePdf),
    ]),
  );
  const buys = raw.trades.filter((trade) => trade.side === "buy").length;
  const sells = raw.trades.filter((trade) => trade.side === "sell").length;
  return {
    id: `fangde-${sources.join("-")}-parsed`,
    severity: "info",
    title: "已解析方德账户月结单",
    detail: `已读取 ${sources.length} 份月结单：买入 ${buys} 笔、卖出 ${sells} 笔、户口变动 ${raw.movements.length} 条、月末持仓 ${raw.positions.length} 条。成交单据与户口变动中的买卖不会重复计入；账户罚息及普通存取款不计为股息收入。`,
    source: sources[0],
  };
}

export async function parseFangdePdfs(
  files: FangdeFileInput[],
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: FangdeRawData = { trades: [], positions: [], movements: [], issues: [], statementDetected: false };

  for (const [fileIndex, file] of files.entries()) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const fileRaw = parseFangdeLines(file.name, lines, fileIndex * 100000);
      raw.trades.push(...fileRaw.trades);
      raw.positions.push(...fileRaw.positions);
      raw.movements.push(...fileRaw.movements);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      parsed.issues.push({
        id: `fangde-${file.name}-pdf-error`,
        severity: "blocking",
        title: "方德 PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  if (!raw.statementDetected) {
    parsed.issues.push({
      id: "fangde-unsupported-statement",
      severity: "blocking",
      title: "方德文件格式不符合要求",
      detail: "当前没有识别到方德证券综合成交单据及账户月结单特征，请确认券商选择和 PDF 文件。",
      source: files[0]?.name,
    });
    return parsed;
  }

  const activities = sortActivities(raw.trades.map(activityFromTrade));
  const missingCost = buildMissingCostData(activities, options.targetYear, options.manualCosts ?? []);
  parsed.tradeActivities.push(...activities);
  parsed.realizedTrades.push(...missingCost.realizedTrades);
  parsed.dividends.push(...dividendsFromMovements(raw.movements));
  parsed.openPositions.push(...latestPositions(raw.positions).map(openPositionFromRecord));
  parsed.costBasisRequests.push(...missingCost.requests);
  parsed.issues.push(...raw.issues, ...missingCost.issues);

  if (raw.trades.length > 0 || raw.positions.length > 0 || raw.movements.length > 0) {
    parsed.issues.push(aggregateIssue(raw));
  } else {
    parsed.issues.push({
      id: "fangde-empty-statement",
      severity: "info",
      title: "本月没有方德账户活动",
      detail: "已识别为方德账户月结单，但没有读取到股票买卖、户口变动或期末持仓记录。",
      source: files[0]?.name,
    });
  }
  if (raw.trades.length === 0) {
    parsed.issues.push({
      id: "fangde-no-stock-activity",
      severity: "info",
      title: "本月没有方德股票交易",
      detail: "已识别为方德账户月结单，本月没有股票买卖记录；系统会继续展示期末持仓和可识别分红用于核对。",
      source: files[0]?.name,
    });
  }
  return parsed;
}
