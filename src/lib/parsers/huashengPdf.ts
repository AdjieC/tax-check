import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { normalizeSymbol } from "./common";
import type { Currency, DividendIncome, ParsedInput, ReviewIssue, TradeActivity } from "@/lib/tax/types";

interface HuashengPdfFileInput {
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

interface StatementRow {
  sourcePdf: string;
  page: number;
  sequence: number;
  currency: Currency;
  tradeDate: string;
  settleDate: string;
  ref: string;
  description: string;
  amount?: number;
}

interface IpoCharge {
  row: StatementRow;
  symbol: string;
  quantity: number;
  kind: "initial" | "handling" | "additional" | "financing" | "refund";
}

interface IpoDeposit {
  row: StatementRow;
  symbol: string;
  securityName: string;
  quantity: number;
}

interface HuashengPdfRawData {
  rows: StatementRow[];
  statementDetected: boolean;
  issues: ReviewIssue[];
}

const HUASHENG_BROKER = "华盛";
const NUMBER_PATTERN = /^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/;

function clean(value: string) {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("華", "华")
    .replaceAll("戶", "户")
    .replaceAll("賬", "账")
    .replaceAll("帳", "账")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("貨", "货")
    .replaceAll("幣", "币")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("數", "数")
    .replaceAll("證", "证")
    .replaceAll("資", "资")
    .replaceAll("產", "产")
    .replaceAll("價", "价")
    .replaceAll("額", "额")
    .replaceAll("餘", "余")
    .replaceAll("轉", "转")
    .replaceAll("後", "后")
    .replaceAll("紅", "红")
    .replaceAll("－", "-")
    .replaceAll("−", "-");
}

function compactText(value: string) {
  return canonicalText(value).replace(/\s+/g, "");
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseNumber(value: string) {
  const parsed = Number(canonicalText(value).replace(/,/g, "").replace(/[()]/g, "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseAmount(value: string) {
  const text = canonicalText(value);
  if (!NUMBER_PATTERN.test(text)) return undefined;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const amount = Math.abs(parseNumber(text));
  return negative ? -amount : amount;
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("RMB") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function marketName(currency: Currency) {
  if (currency === "USD") return "美国市场";
  if (currency === "CNY") return "A股通";
  return "香港市场";
}

const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

function normalizeDate(value: string) {
  const text = canonicalText(value).toUpperCase();
  const english = text.match(/^(\d{1,2})\s+([A-Z]{3})\s+(20\d{2})$/);
  if (english && MONTHS[english[2]]) {
    return `${english[3]}-${MONTHS[english[2]]}-${english[1].padStart(2, "0")}`;
  }
  const iso = text.match(/^(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  return "";
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

function lineDate(line: TextLine) {
  return normalizeDate(lineCell(line, 20, 90));
}

function isValuableCapitalStatement(lines: TextLine[]) {
  const text = canonicalText(lines.map((line) => line.text).join("\n"));
  const compact = compactText(text);
  const lower = text.toLowerCase();
  const brokerDetected =
    text.includes("华盛资本证券") ||
    lower.includes("valuable capital") ||
    lower.includes("valuable.com.hk") ||
    (compact.includes("中央编号:AUL711") && compact.includes("账户结单"));
  return brokerDetected && (compact.includes("月结单") || compact.includes("账户结单"));
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
          .sort((left, right) => right.y - left.y || left.x - right.x);

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
            .sort((left, right) => right.y - left.y)
            .map((group) => {
              const sortedTokens = group.tokens.sort((left, right) => left.x - right.x);
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

function statementRows(sourcePdf: string, lines: TextLine[]) {
  const rows: StatementRow[] = [];
  let activeTable = false;
  let activeCurrency: Currency = "HKD";
  let sequence = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const compact = compactText(line.text);
    if (compact.includes("账户结单")) {
      activeTable = true;
      continue;
    }
    if (activeTable && compact.includes("利率总结")) {
      activeTable = false;
      continue;
    }
    if (!activeTable) continue;
    if (compact.startsWith("货币:")) {
      activeCurrency = mapCurrency(line.text);
      continue;
    }

    const tradeDate = lineDate(line);
    if (!tradeDate) continue;
    let cursor = index + 1;
    const descriptionParts = [lineCell(line, 210, 440)].filter(Boolean);
    while (cursor < lines.length && lines[cursor].page === line.page && !lineDate(lines[cursor])) {
      const continuation = compactText(lines[cursor].text);
      if (continuation.includes("利率总结") || continuation.includes("转后结余")) break;
      const description = lineCell(lines[cursor], 210, 440);
      if (description) descriptionParts.push(description);
      cursor += 1;
    }

    const amountTokens = line.tokens.filter(
      (token) => token.x >= 430 && token.x < 515 && NUMBER_PATTERN.test(canonicalText(token.text)),
    );
    const amount = amountTokens.length > 0 ? parseAmount(amountTokens[amountTokens.length - 1].text) : undefined;
    rows.push({
      sourcePdf,
      page: line.page,
      sequence,
      currency: activeCurrency,
      tradeDate,
      settleDate: normalizeDate(lineCell(line, 85, 143)),
      ref: clean(lineCell(line, 135, 216)).replace(/\s+/g, ""),
      description: clean(descriptionParts.join(" ")),
      amount,
    });
    sequence += 1;
    index = Math.max(index, cursor - 1);
  }
  return rows;
}

function parseDirectTrade(row: StatementRow): TradeActivity | null {
  if (row.amount === undefined) return null;
  const description = compactText(row.description);
  const sideMatch = description.match(/^(买|卖)#?(\d{4,6})/);
  const priceMatch = description.match(/(\d[\d,]*)@(\d+(?:\.\d+)?)$/);
  if (!sideMatch || !priceMatch) return null;

  const side = sideMatch[1] === "卖" ? "sell" : "buy";
  const symbol = normalizeSymbol(sideMatch[2]);
  const quantity = Math.abs(parseNumber(priceMatch[1]));
  const unitPrice = Math.abs(parseNumber(priceMatch[2]));
  if (!symbol || quantity <= 0 || unitPrice <= 0) return null;

  const nameStart = sideMatch[0].length;
  const nameEnd = priceMatch.index ?? description.length;
  const securityName = description.slice(nameStart, nameEnd).replace(/^#/, "").trim() || symbol;
  const grossAmount = roundMoney(quantity * unitPrice);
  const amount = roundMoney(Math.abs(row.amount));
  const fee = roundMoney(Math.abs(amount - grossAmount));
  return {
    id: `huasheng-pdf-trade-${row.tradeDate}-${row.sequence}-${row.currency}-${symbol}-${side}`,
    broker: HUASHENG_BROKER,
    date: row.tradeDate,
    sequence: row.sequence,
    market: marketName(row.currency),
    currency: row.currency,
    symbol,
    securityName,
    side,
    quantity,
    unitPrice,
    grossAmount,
    fee,
    amount,
    source: `${row.sourcePdf} 第 ${row.page} 页`,
    note: `华盛资本证券月结单；参考编号 ${row.ref || "未列示"}${row.settleDate ? `；结算日 ${row.settleDate}` : ""}；${
      side === "buy" ? "买入成本按净扣款确认" : "卖出收入按净收款确认"
    }。`,
  };
}

function symbolAndQuantity(value: string) {
  const text = compactText(value).toUpperCase();
  const symbolMatch = text.match(/(\d{4,6})\.?HK/);
  const quantityMatch = text.match(/(\d[\d,]*)SHARES/);
  if (!symbolMatch) return null;
  return {
    symbol: normalizeSymbol(symbolMatch[1]),
    quantity: quantityMatch ? Math.abs(parseNumber(quantityMatch[1])) : 0,
  };
}

function parseIpoCharge(row: StatementRow): IpoCharge | null {
  if (row.amount === undefined) return null;
  const description = compactText(row.description).toUpperCase();
  const security = symbolAndQuantity(description);
  if (!security) return null;

  let kind: IpoCharge["kind"] | null = null;
  if (description.includes("ADDITIONALEIPOAPPLICATIONFEE")) kind = "additional";
  else if (description.includes("HANDLINGFEEFOREIPO")) kind = "handling";
  else if (description.includes("IPOFINANCINGINTEREST")) kind = "financing";
  else if (description.includes("REFUNDFOREIPO")) kind = "refund";
  else if (description.includes("EIPOAPPLICATIONFEE")) kind = "initial";
  if (!kind) return null;
  return { row, ...security, kind };
}

function normalizedSecurityName(value: string, symbol: string) {
  const canonical = canonicalText(value);
  const marker = canonical.match(new RegExp(`#?0*${Number(symbol)}\\s*([^#]+?)(?:股数|$)`));
  if (!marker) return symbol;
  const name = marker[1].trim();
  return /[^\x00-\x7F]/.test(name) ? name.replace(/\s+/g, "") : clean(name);
}

function parseIpoDeposit(row: StatementRow): IpoDeposit | null {
  const description = compactText(row.description).toUpperCase();
  if (!description.includes("STOCKDEPOSITEIPO")) return null;
  const security = symbolAndQuantity(description);
  if (!security) return null;
  const quantityFromShareCount = description.match(/股数:(\d[\d,]*)/);
  const quantity = quantityFromShareCount ? Math.abs(parseNumber(quantityFromShareCount[1])) : security.quantity;
  if (quantity <= 0) return null;
  return {
    row,
    symbol: security.symbol,
    securityName: normalizedSecurityName(row.description, security.symbol),
    quantity,
  };
}

function parseDividend(row: StatementRow): DividendIncome | null {
  if (row.amount === undefined || row.amount <= 0) return null;
  const description = canonicalText(row.description);
  if (!/(现金)?股息|红利|DIVIDEND/i.test(description)) return null;
  if (/REFUND|退款|退回/i.test(description)) return null;
  const symbolMatch = compactText(description).toUpperCase().match(/#?(\d{4,6})(?:\.?HK)?/);
  const symbol = symbolMatch ? normalizeSymbol(symbolMatch[1]) : "CASH";
  return {
    id: `huasheng-pdf-dividend-${row.tradeDate}-${row.sequence}-${row.currency}-${symbol}`,
    broker: HUASHENG_BROKER,
    date: row.tradeDate,
    currency: row.currency,
    symbol,
    securityName: symbol === "CASH" ? "现金股息" : symbol,
    grossAmount: roundMoney(row.amount),
    taxWithheld: 0,
    fee: 0,
    source: `${row.sourcePdf} 第 ${row.page} 页`,
    note: "华盛资本证券月结单现金收入；月结单未单列税前金额和预扣税，当前按到账金额记录，正式申报前请结合公司行动通知复核。",
  };
}

function ipoActivitiesAndIssues(rows: StatementRow[]) {
  const charges = rows.flatMap((row) => {
    const charge = parseIpoCharge(row);
    return charge ? [charge] : [];
  });
  const deposits = rows.flatMap((row) => {
    const deposit = parseIpoDeposit(row);
    return deposit ? [deposit] : [];
  });
  const activities: TradeActivity[] = [];
  const issues: ReviewIssue[] = [];
  const consumedCharges = new Set<IpoCharge>();

  for (const deposit of deposits.sort((left, right) => left.row.tradeDate.localeCompare(right.row.tradeDate) || left.row.sequence - right.row.sequence)) {
    const related = charges.filter(
      (charge) =>
        !consumedCharges.has(charge) &&
        charge.symbol === deposit.symbol &&
        (charge.row.tradeDate < deposit.row.tradeDate ||
          (charge.row.tradeDate === deposit.row.tradeDate && charge.row.sequence <= deposit.row.sequence)),
    );
    related.forEach((charge) => consumedCharges.add(charge));

    const initial = related.filter((charge) => charge.kind === "initial");
    const additional = related.filter((charge) => charge.kind === "additional");
    const handling = related.filter((charge) => charge.kind === "handling");
    const financing = related.filter((charge) => charge.kind === "financing");
    const refunds = related.filter((charge) => charge.kind === "refund");
    const sum = (items: IpoCharge[]) => items.reduce((total, charge) => total + Math.abs(charge.row.amount ?? 0), 0);
    const knownCost = roundMoney(sum(initial) + sum(additional) + sum(handling) - sum(refunds));
    const financingInterest = roundMoney(sum(financing));
    const hasCompleteCost = initial.length > 0 && knownCost > 0;
    const source = `${deposit.row.sourcePdf} 第 ${deposit.row.page} 页`;

    activities.push({
      id: `huasheng-pdf-ipo-${deposit.row.tradeDate}-${deposit.row.sequence}-${deposit.row.currency}-${deposit.symbol}`,
      broker: HUASHENG_BROKER,
      date: deposit.row.tradeDate,
      sequence: deposit.row.sequence,
      market: marketName(deposit.row.currency),
      currency: deposit.row.currency,
      symbol: deposit.symbol,
      securityName: deposit.securityName,
      side: "acquire",
      quantity: deposit.quantity,
      unitPrice: hasCompleteCost ? roundMoney((knownCost - sum(handling)) / deposit.quantity) : undefined,
      grossAmount: hasCompleteCost ? roundMoney(knownCost - sum(handling)) : undefined,
      fee: hasCompleteCost ? roundMoney(sum(handling)) : undefined,
      amount: hasCompleteCost ? knownCost : 0,
      source,
      note: hasCompleteCost
        ? `华盛资本证券新股入账；参考编号 ${deposit.row.ref || "未列示"}；成本按申购扣款、追加扣款、手续费和退款净额确认${
            financingInterest > 0 ? `，IPO 融资利息 ${financingInterest} 未并入证券成本` : ""
          }。`
        : `华盛资本证券新股入账；参考编号 ${deposit.row.ref || "未列示"}；当前材料缺少首次申购扣款，已看到的部分扣款不会被误当作完整成本。`,
      excludedFromTaxReplay: !hasCompleteCost,
    });

    if (!hasCompleteCost) {
      issues.push({
        id: `huasheng-pdf-ipo-cost-gap-${deposit.row.tradeDate}-${deposit.symbol}-${deposit.row.sequence}`,
        severity: "warning",
        title: `${deposit.symbol} 新股申购成本跨月缺失`,
        detail: `${deposit.row.tradeDate} 入账 ${deposit.quantity} 股，但当前上传的华盛资本证券月结单没有找到该次新股的首次申购扣款。系统不会用追加扣款替代完整成本；请补充更早月份月结单，卖出时也可在待补成本中填写总成本。`,
        source,
      });
    }
  }
  return { activities, issues, allocationCount: deposits.length };
}

function parseHuashengPdfLines(sourcePdf: string, lines: TextLine[]): HuashengPdfRawData {
  const statementDetected = isValuableCapitalStatement(lines);
  return {
    rows: statementDetected ? statementRows(sourcePdf, lines) : [],
    statementDetected,
    issues: [],
  };
}

export async function parseHuashengPdfFiles(files: HuashengPdfFileInput[]): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: HuashengPdfRawData = { rows: [], statementDetected: false, issues: [] };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const fileRaw = parseHuashengPdfLines(file.name, lines);
      raw.rows.push(...fileRaw.rows);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      parsed.issues.push({
        id: `huasheng-pdf-error-${file.name}`,
        severity: "blocking",
        title: "华盛资本证券 PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  if (!raw.statementDetected) {
    parsed.issues.push({
      id: "huasheng-pdf-unsupported-statement",
      severity: "blocking",
      title: "华盛 PDF 文件格式不符合要求",
      detail: "当前没有识别到华盛资本证券 / Valuable Capital 月结单特征。华盛通报税 Excel 仍请上传“证券交易记录表”或“公司行动记录表”。",
      source: files[0]?.name,
    });
    return parsed;
  }

  const directActivities = raw.rows.flatMap((row) => {
    const activity = parseDirectTrade(row);
    return activity ? [activity] : [];
  });
  const ipo = ipoActivitiesAndIssues(raw.rows);
  const dividends = raw.rows.flatMap((row) => {
    const dividend = parseDividend(row);
    return dividend ? [dividend] : [];
  });
  const activities = [...directActivities, ...ipo.activities].sort(
    (left, right) => left.date.localeCompare(right.date) || (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id),
  );

  parsed.tradeActivities.push(...activities);
  parsed.dividends.push(...dividends);
  parsed.issues.push(...raw.issues, ...ipo.issues);
  parsed.issues.push({
    id: `huasheng-pdf-parsed-${files.map((file) => file.name).join("-")}`,
    severity: "info",
    title: "已解析华盛资本证券 PDF 月结单",
    detail: `已读取 ${files.length} 份月结单：普通买入 ${directActivities.filter((item) => item.side === "buy").length} 笔、普通卖出 ${
      directActivities.filter((item) => item.side === "sell").length
    } 笔、新股入账 ${ipo.allocationCount} 笔、现金股息 ${dividends.length} 笔。普通买卖按净扣款/净收款入账；IPO 融资利息不并入证券成本，跨月缺少首次申购扣款时会提示补成本。`,
    source: files[0]?.name,
  });
  return parsed;
}
