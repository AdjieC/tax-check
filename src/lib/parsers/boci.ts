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

interface BociFileInput {
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

interface BociTradeRecord {
  sourcePdf: string;
  page: number;
  tradeDate: string;
  settleDate: string;
  ref: string;
  side: "buy" | "sell";
  symbol: string;
  securityName: string;
  market: string;
  currency: Currency;
  quantity: number;
  unitPrice: number;
  amount: number;
  fee: number;
  sequence: number;
  pendingSettlement: boolean;
}

interface BociPositionRecord {
  sourcePdf: string;
  page: number;
  statementDate: string;
  symbol: string;
  securityName: string;
  market: string;
  currency: Currency;
  quantity: number;
  closingPrice: number;
  marketValue: number;
}

interface BociIncomeRecord {
  sourcePdf: string;
  page: number;
  date: string;
  currency: Currency;
  kind: "interest" | "dividend";
  description: string;
  amount: number;
  sequence: number;
}

interface BociRawData {
  trades: BociTradeRecord[];
  positions: BociPositionRecord[];
  incomes: BociIncomeRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

const BOCI_BROKER = "中银国际";

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("客戶", "客户")
    .replaceAll("戶口", "户口")
    .replaceAll("帳戶", "账户")
    .replaceAll("賬戶", "账户")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("總", "总")
    .replaceAll("證券", "证券")
    .replaceAll("倉", "仓")
    .replaceAll("終", "终")
    .replaceAll("價", "价")
    .replaceAll("數", "数")
    .replaceAll("餘", "余")
    .replaceAll("馀", "余")
    .replaceAll("應收", "应收")
    .replaceAll("應付", "应付")
    .replaceAll("紅利", "红利")
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

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function marketName(currency: Currency) {
  if (currency === "USD") return "美国市场";
  if (currency === "CNY") return "A股通";
  return "香港市场";
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

function numericTokens(line: TextLine, minX = 0) {
  return line.tokens.filter((token) => token.x >= minX && /^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/.test(canonicalText(token.text)));
}

function normalizeStatementDate(lines: TextLine[]) {
  const text = canonicalText(lines.slice(0, 30).map((line) => line.text).join("\n"));
  const match = text.match(/结单日期\s*[:：]\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function normalizeShortDate(value: string, statementDate: string) {
  const match = canonicalText(value).match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match || !statementDate) return "";
  const statementYear = Number(statementDate.slice(0, 4));
  const statementMonth = Number(statementDate.slice(5, 7));
  const month = Number(match[2]);
  const year =
    statementMonth === 1 && month === 12
      ? statementYear - 1
      : statementMonth === 12 && month === 1
        ? statementYear + 1
        : statementYear;
  return `${year}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function isBociStatement(lines: TextLine[]) {
  const text = canonicalText(lines.slice(0, 80).map((line) => line.text).join("\n"));
  const lower = text.toLowerCase();
  return (
    lower.includes("boci securities limited") ||
    text.includes("中银国际证券有限公司") ||
    (text.includes("账户月结单") && (lower.includes("bocionline.com") || text.includes("AAC298")))
  );
}

async function extractPdfLines(fileName: string, data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
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

function parseTradeLine(
  sourcePdf: string,
  lines: TextLine[],
  index: number,
  statementDate: string,
  currency: Currency,
  sequence: number,
  pendingSettlement: boolean,
): BociTradeRecord | null {
  const line = lines[index];
  const tradeDateText = lineCell(line, 45, 88);
  const settleDateText = lineCell(line, 88, 122);
  if (!/^\d{1,2}\/\d{1,2}$/.test(tradeDateText) || !/^\d{1,2}\/\d{1,2}$/.test(settleDateText)) return null;

  const ref = lineCell(line, 122, 170);
  if (!/^\d{6,}$/.test(ref)) return null;
  const detail = canonicalText(lineCell(line, 170, 345));
  const detailMatch = detail.match(/^(买入|卖出)\s+([A-Z0-9.]+)\s+(.+)$/i);
  if (!detailMatch) return null;

  const quantityLine = lines[index + 1];
  const priceLine = lines[index + 2];
  if (!quantityLine || quantityLine.page !== line.page || !compactText(quantityLine.text).startsWith("股数")) return null;
  if (!priceLine || priceLine.page !== line.page || !compactText(priceLine.text).startsWith("平均价")) return null;

  const amountToken = numericTokens(line, 340)[0];
  const quantityToken = numericTokens(quantityLine, 185)[0];
  const priceToken = numericTokens(priceLine, 190)[0];
  if (!amountToken || !quantityToken || !priceToken) return null;

  const quantity = Math.abs(parseNumber(quantityToken.text));
  const unitPrice = Math.abs(parseNumber(priceToken.text));
  const amount = Math.abs(parseNumber(amountToken.text));
  if (quantity <= 0 || unitPrice <= 0 || amount <= 0) return null;

  const side = detailMatch[1] === "买入" ? "buy" : "sell";
  const grossAmount = quantity * unitPrice;
  const fee = side === "buy" ? Math.max(0, amount - grossAmount) : Math.max(0, grossAmount - amount);
  return {
    sourcePdf,
    page: line.page,
    tradeDate: normalizeShortDate(tradeDateText, statementDate),
    settleDate: normalizeShortDate(settleDateText, statementDate),
    ref,
    side,
    symbol: normalizeSymbol(detailMatch[2]),
    securityName: clean(detailMatch[3]),
    market: marketName(currency),
    currency,
    quantity,
    unitPrice,
    amount,
    fee: roundMoney(fee),
    sequence,
    pendingSettlement,
  };
}

function parsePositionLine(
  sourcePdf: string,
  lines: TextLine[],
  index: number,
  statementDate: string,
  currency: Currency,
): BociPositionRecord | null {
  const line = lines[index];
  const valuesLine = lines[index + 1];
  if (!valuesLine || valuesLine.page !== line.page) return null;

  const symbol = canonicalText(lineCell(line, 50, 100)).toUpperCase();
  if (!/^[A-Z0-9.]{1,12}$/.test(symbol)) return null;
  const securityName = canonicalText(lineCell(line, 100, 450)).replace(/\s+/g, " ").trim();
  if (!securityName) return null;

  const quantityToken = numericTokens(valuesLine, 300).find((token) => token.x < 360);
  const priceToken = numericTokens(valuesLine, 360).find((token) => token.x < 430);
  const marketValueToken = numericTokens(valuesLine, 425).find((token) => token.x < 495);
  if (!quantityToken || !priceToken || !marketValueToken) return null;

  return {
    sourcePdf,
    page: line.page,
    statementDate,
    symbol: normalizeSymbol(symbol),
    securityName,
    market: marketName(currency),
    currency,
    quantity: Math.abs(parseNumber(quantityToken.text)),
    closingPrice: Math.abs(parseNumber(priceToken.text)),
    marketValue: Math.abs(parseNumber(marketValueToken.text)),
  };
}

function parseIncomeLine(
  sourcePdf: string,
  line: TextLine,
  statementDate: string,
  currency: Currency,
  sequence: number,
): BociIncomeRecord | null {
  const tradeDateText = lineCell(line, 45, 88);
  if (!/^\d{1,2}\/\d{1,2}$/.test(tradeDateText)) return null;
  const description = canonicalText(lineCell(line, 170, 345));
  const kind = description.includes("利息") ? "interest" : /股息|红利/.test(description) ? "dividend" : null;
  if (!kind) return null;
  const amountToken = numericTokens(line, 340)[0];
  if (!amountToken) return null;
  const amount = parseNumber(amountToken.text);
  if (amount <= 0) return null;
  return {
    sourcePdf,
    page: line.page,
    date: normalizeShortDate(tradeDateText, statementDate),
    currency,
    kind,
    description,
    amount,
    sequence,
  };
}

function parseBociLines(sourcePdf: string, lines: TextLine[], baseSequence: number): BociRawData {
  const statementDate = normalizeStatementDate(lines);
  const raw: BociRawData = {
    trades: [],
    positions: [],
    incomes: [],
    issues: [],
    statementDetected: isBociStatement(lines),
  };
  let currency: Currency = "HKD";
  let pendingSettlement = false;
  let inPositions = false;
  let sequence = baseSequence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = canonicalText(line.text);
    const compact = compactText(text);

    const currencyMatch = text.match(/(?:美元|港元|人民币).*\((USD|HKD|CNY)\)/i);
    if (currencyMatch) currency = mapCurrency(currencyMatch[1]);
    if (compact.includes("待结算交易")) pendingSettlement = true;
    if (compact.includes("证券存仓摘要")) {
      inPositions = true;
      pendingSettlement = false;
      continue;
    }
    if (/员工认股权|有限制股票摘要|户口总览|备注/.test(compact)) inPositions = false;

    const marketCurrencyMatch = text.match(/(?:美国|香港|中国).*(USD|HKD|CNY)/i);
    if (marketCurrencyMatch) currency = mapCurrency(marketCurrencyMatch[1]);

    const trade = parseTradeLine(sourcePdf, lines, index, statementDate, currency, sequence, pendingSettlement);
    if (trade) {
      raw.trades.push(trade);
      sequence += 1;
      index += 2;
      continue;
    }

    const income = parseIncomeLine(sourcePdf, line, statementDate, currency, sequence);
    if (income) {
      raw.incomes.push(income);
      sequence += 1;
      continue;
    }

    if (inPositions && statementDate) {
      const position = parsePositionLine(sourcePdf, lines, index, statementDate, currency);
      if (position) {
        if (position.quantity > 0) raw.positions.push(position);
        index += 1;
      }
    }
  }

  if (!statementDate && raw.statementDetected) {
    raw.issues.push({
      id: `boci-${sourcePdf}-missing-statement-date`,
      severity: "blocking",
      title: "未识别中银国际结单日期",
      detail: "交易日期只有日/月，必须从结单日期补全年份后才能安全计算。",
      source: sourcePdf,
    });
  }
  return raw;
}

function activityFromTrade(trade: BociTradeRecord): TradeActivity {
  return {
    id: `boci-activity-${trade.tradeDate}-${trade.sequence}-${trade.ref}-${trade.symbol}`,
    broker: BOCI_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: trade.market,
    currency: trade.currency,
    symbol: trade.symbol,
    securityName: trade.securityName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: roundMoney(trade.quantity * trade.unitPrice),
    fee: trade.fee,
    amount: trade.amount,
    source: trade.sourcePdf,
    note: `${trade.ref}${trade.pendingSettlement ? "；待结算交易" : ""}；中银国际账户月结单第 ${trade.page} 页`,
  };
}

function incomeFromRecord(income: BociIncomeRecord): DividendIncome {
  const isInterest = income.kind === "interest";
  return {
    id: `boci-${income.kind}-${income.date}-${income.sequence}-${income.currency}`,
    broker: BOCI_BROKER,
    date: income.date,
    currency: income.currency,
    symbol: isInterest ? "CASH-INTEREST" : "CASH-DIVIDEND",
    securityName: isInterest ? "中银国际现金利息" : "中银国际现金股息",
    grossAmount: income.amount,
    taxWithheld: 0,
    fee: 0,
    source: income.sourcePdf,
    note: `${income.description}；中银国际账户月结单`,
    evidence: {
      page: income.page,
      text: `${income.date} ${income.description} ${income.currency} ${income.amount.toFixed(2)}`,
    },
  };
}

function openPositionFromRecord(position: BociPositionRecord): OpenPosition {
  return {
    id: `boci-open-${position.statementDate}-${position.currency}-${position.symbol}`,
    broker: BOCI_BROKER,
    asOf: position.statementDate,
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    source: position.sourcePdf,
    note: `中银国际月末证券存仓；收市价 ${position.closingPrice.toFixed(6)}，未实现盈亏不计入资本利得。`,
  };
}

function manualCostMap(manualCosts: ManualCostInput[]) {
  const map = new Map<string, number>();
  for (const item of manualCosts) {
    if (!item.id || !Number.isFinite(item.costBasis) || item.costBasis < 0) continue;
    map.set(item.id, item.costBasis);
  }
  return map;
}

function buildMissingCostData(
  trades: BociTradeRecord[],
  targetYear: number | undefined,
  manualCosts: ManualCostInput[],
): { realizedTrades: RealizedTrade[]; requests: CostBasisRequest[]; issues: ReviewIssue[] } {
  const quantities = new Map<string, number>();
  const realizedTrades: RealizedTrade[] = [];
  const requests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];
  const costs = manualCostMap(manualCosts);
  const ordered = [...trades].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.sequence - b.sequence);

  for (const trade of ordered) {
    const key = `${trade.currency}::${trade.symbol}`;
    const trackedQuantity = quantities.get(key) ?? 0;
    if (trade.side === "buy") {
      quantities.set(key, trackedQuantity + trade.quantity);
      continue;
    }
    if (trackedQuantity + 1e-7 >= trade.quantity) {
      quantities.set(key, trackedQuantity - trade.quantity);
      continue;
    }
    quantities.set(key, 0);
    if (targetYear !== undefined && !trade.tradeDate.startsWith(String(targetYear))) continue;

    const requestId = `boci-cost-${targetYear ?? "unknown"}-${trade.currency}-${trade.symbol}-${trade.tradeDate}-${trade.ref}`;
    const manualCostBasis = costs.get(requestId);
    if (manualCostBasis !== undefined) {
      realizedTrades.push({
        id: `${requestId}-manual`,
        broker: BOCI_BROKER,
        sellDate: trade.tradeDate,
        sequence: trade.sequence,
        market: trade.market,
        currency: trade.currency,
        symbol: trade.symbol,
        securityName: trade.securityName,
        quantity: trade.quantity,
        proceeds: trade.amount,
        costBasis: manualCostBasis,
        gainLoss: trade.amount - manualCostBasis,
        source: trade.sourcePdf,
        note: `用户手动补录这笔卖出总成本：${manualCostBasis}`,
        useBrokerReportedGainLoss: true,
      });
      continue;
    }

    requests.push({
      id: requestId,
      broker: BOCI_BROKER,
      sellDate: trade.tradeDate,
      sequence: trade.sequence,
      market: trade.market,
      currency: trade.currency,
      symbol: trade.symbol,
      securityName: trade.securityName,
      quantity: trade.quantity,
      trackedQuantity,
      proceeds: trade.amount,
      source: trade.sourcePdf,
      note: `参考编号 ${trade.ref}；手动补录这笔成本后计入资本利得`,
    });
    issues.push({
      id: `${requestId}-cost-gap`,
      severity: "warning",
      title: `${trade.symbol} 历史成本缺失`,
      detail: `${trade.tradeDate} 卖出 ${trade.quantity} 股，但上传的中银国际月结单中最多只追踪到 ${trackedQuantity} 股成本。请补充更早月份月结单，或在待补成本中填写这笔卖出的总成本。`,
      source: trade.sourcePdf,
    });
  }

  return { realizedTrades, requests, issues };
}

function latestPositions(positions: BociPositionRecord[]) {
  const latest = new Map<string, BociPositionRecord>();
  for (const position of positions) {
    const key = `${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementDate.localeCompare(existing.statementDate) >= 0) latest.set(key, position);
  }
  return Array.from(latest.values()).sort((a, b) => a.currency.localeCompare(b.currency) || a.symbol.localeCompare(b.symbol));
}

function aggregateIssue(raw: BociRawData): ReviewIssue {
  const buys = raw.trades.filter((trade) => trade.side === "buy");
  const sells = raw.trades.filter((trade) => trade.side === "sell");
  const pending = raw.trades.filter((trade) => trade.pendingSettlement);
  const sources = Array.from(
    new Set([
      ...raw.trades.map((trade) => trade.sourcePdf),
      ...raw.positions.map((position) => position.sourcePdf),
      ...raw.incomes.map((income) => income.sourcePdf),
    ]),
  );
  const proceedsByCurrency = new Map<Currency, number>();
  for (const trade of sells) {
    proceedsByCurrency.set(trade.currency, (proceedsByCurrency.get(trade.currency) ?? 0) + trade.amount);
  }
  const proceedsText = Array.from(proceedsByCurrency.entries())
    .map(
      ([currency, amount]) =>
        `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    )
    .join("、");
  return {
    id: `boci-${sources.join("-")}-parsed`,
    severity: "info",
    title: "已解析中银国际账户月结单",
    detail: `已读取 ${sources.length} 份月结单：买入 ${buys.length} 笔，卖出 ${sells.length} 笔${proceedsText ? `（卖出流水 ${proceedsText}）` : ""}，其中待结算 ${pending.length} 笔；现金利息/股息 ${raw.incomes.length} 笔，月末持仓 ${raw.positions.length} 条。系统按成交日期重放成本，待结算交易不会遗漏。`,
    source: sources[0],
  };
}

export async function parseBociPdfs(
  files: BociFileInput[],
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: BociRawData = {
    trades: [],
    positions: [],
    incomes: [],
    issues: [],
    statementDetected: false,
  };

  for (const [fileIndex, file] of files.entries()) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const fileRaw = parseBociLines(file.name, lines, fileIndex * 100000);
      raw.trades.push(...fileRaw.trades);
      raw.positions.push(...fileRaw.positions);
      raw.incomes.push(...fileRaw.incomes);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      parsed.issues.push({
        id: `boci-${file.name}-pdf-error`,
        severity: "blocking",
        title: "中银国际 PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  if (!raw.statementDetected) {
    parsed.issues.push({
      id: "boci-unsupported-statement",
      severity: "blocking",
      title: "中银国际文件格式不符合要求",
      detail: "当前没有识别到 BOCI Securities Limited / 中银国际证券账户月结单特征，请确认券商选择和 PDF 文件。",
      source: files[0]?.name,
    });
    return parsed;
  }

  parsed.tradeActivities.push(...raw.trades.map(activityFromTrade));
  parsed.dividends.push(...raw.incomes.map(incomeFromRecord));
  parsed.openPositions.push(...latestPositions(raw.positions).map(openPositionFromRecord));
  const missingCost = buildMissingCostData(raw.trades, options.targetYear, options.manualCosts ?? []);
  parsed.realizedTrades.push(...missingCost.realizedTrades);
  parsed.costBasisRequests.push(...missingCost.requests);
  parsed.issues.push(...raw.issues, ...missingCost.issues);

  if (raw.trades.length > 0 || raw.positions.length > 0 || raw.incomes.length > 0) {
    parsed.issues.push(aggregateIssue(raw));
  } else {
    parsed.issues.push({
      id: "boci-empty-statement",
      severity: "info",
      title: "本月没有中银国际股票交易",
      detail: "已识别为中银国际账户月结单，但没有读取到股票买卖、现金利息/股息或证券存仓记录。",
      source: files[0]?.name,
    });
  }

  return parsed;
}
