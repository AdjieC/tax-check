import * as XLSX from "xlsx";
import { asCurrency, asNumber, normalizeSymbol, ParserValidationError, sourceId } from "./common";
import { parseHuashengPdfFiles } from "./huashengPdf";
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

interface HuashengFileInput {
  name: string;
  data: ArrayBuffer;
}

interface WorkbookContext {
  fileName: string;
  workbook: XLSX.WorkBook;
}

interface ManualCostInput {
  id: string;
  costBasis: number;
}

const HUASHENG_BROKER = "华盛";
const TRADE_SHEET = "证券交易记录表";
const COMPANY_ACTION_SHEET = "公司行动记录表";

const TRADE_HEADERS = ["参考编号", "交易日期", "市场", "币种", "股票代码", "股票名称", "买/卖", "价格", "数量", "交易金额", "交易费用合计"];
const COMPANY_ACTION_HEADERS = ["登记日", "派发日", "市场", "股票代码", "股票名称", "登记数量", "派红利币种", "派发红利金额", "费用"];

function rowObject(headers: unknown[], values: unknown[]) {
  return Object.fromEntries(headers.map((header, index) => [String(header ?? "").normalize("NFKC").trim(), values[index]]));
}

function readRows(workbook: XLSX.WorkBook, sheetName: string) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false,
  });
}

function hasHeaders(workbook: XLSX.WorkBook, sheetName: string, requiredHeaders: string[]) {
  const rows = readRows(workbook, sheetName);
  const headers = new Set((rows[0] ?? []).map((header) => String(header ?? "").normalize("NFKC").trim()));
  return requiredHeaders.every((header) => headers.has(header));
}

function validateWorkbook(context: WorkbookContext) {
  const hasTrades = hasHeaders(context.workbook, TRADE_SHEET, TRADE_HEADERS);
  const hasCompanyActions = hasHeaders(context.workbook, COMPANY_ACTION_SHEET, COMPANY_ACTION_HEADERS);
  if (hasTrades || hasCompanyActions) return;

  const sheetNames = context.workbook.SheetNames.join("、") || "无工作表";
  throw new ParserValidationError(
    `华盛证券目前只支持“证券交易记录表”和“公司行动记录表”Excel。${context.fileName} 的工作表为：${sheetNames}。请不要上传期初/期末账户资产表，它只适合人工核对持仓余额。`,
    context.fileName,
  );
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function dateFromExcelSerial(value: number) {
  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) return "";
  return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
}

function normalizeDate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  if (typeof value === "number" && value > 20000 && value < 80000) {
    return dateFromExcelSerial(value);
  }

  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/\//g, "-")
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?.*$/, "")
    .trim();
  const direct = text.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (direct) return `${direct[1]}-${pad2(Number(direct[2]))}-${pad2(Number(direct[3]))}`;
  const cn = text.match(/^(20\d{2})年(\d{1,2})月(\d{1,2})日?$/);
  if (cn) return `${cn[1]}-${pad2(Number(cn[2]))}-${pad2(Number(cn[3]))}`;
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) return dateFromExcelSerial(serial);
  return text;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function marketName(value: unknown, currency: Currency) {
  const text = String(value ?? "").normalize("NFKC");
  if (text.includes("美股")) return "美国市场";
  if (text.includes("港股")) return "香港市场";
  if (currency === "USD") return "美国市场";
  if (currency === "CNY") return "A股通";
  return "香港市场";
}

function tradeSide(value: unknown): "buy" | "sell" | null {
  const text = String(value ?? "").normalize("NFKC");
  if (text.includes("买")) return "buy";
  if (text.includes("卖")) return "sell";
  return null;
}

function securityKey(item: Pick<TradeActivity, "currency" | "symbol">) {
  return `${item.currency}::${normalizeSymbol(item.symbol)}`;
}

function activitySort(left: TradeActivity, right: TradeActivity) {
  return (
    left.date.localeCompare(right.date) ||
    (left.sequence ?? 0) - (right.sequence ?? 0) ||
    left.id.localeCompare(right.id)
  );
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

function parseTradeActivities(contexts: WorkbookContext[]) {
  const activities: TradeActivity[] = [];

  for (const context of contexts) {
    if (!hasHeaders(context.workbook, TRADE_SHEET, TRADE_HEADERS)) continue;
    const rows = readRows(context.workbook, TRADE_SHEET);
    const headers = rows[0] ?? [];

    rows.slice(1).forEach((values, index) => {
      const row = rowObject(headers, values);
      const date = normalizeDate(row["交易日期"]);
      const currency = asCurrency(row["币种"]);
      const symbol = normalizeSymbol(row["股票代码"]);
      const side = tradeSide(row["买/卖"]);
      const quantity = Math.abs(asNumber(row["数量"]));
      const grossAmount = Math.abs(asNumber(row["交易金额"]));
      const fee = Math.abs(asNumber(row["交易费用合计"]));
      if (!date || !symbol || !side || quantity <= 0 || grossAmount <= 0) return;

      const sequence = index + 1;
      const amount = side === "buy" ? roundMoney(grossAmount + fee) : roundMoney(Math.max(grossAmount - fee, 0));
      const source = sourceId(context.fileName, index + 2);

      activities.push({
        id: `huasheng-activity-${date}-${sequence}-${currency}-${symbol}-${side}`,
        broker: HUASHENG_BROKER,
        date,
        sequence,
        market: marketName(row["市场"], currency),
        currency,
        symbol,
        securityName: String(row["股票名称"] ?? symbol).trim() || symbol,
        side,
        quantity,
        unitPrice: asNumber(row["价格"]),
        grossAmount,
        fee,
        amount,
        source,
        note:
          side === "buy"
            ? `华盛证券交易记录表买入；成本按交易金额加交易费用计算。`
            : `华盛证券交易记录表卖出；卖出收入按交易金额扣除交易费用计算。`,
      });
    });
  }

  return activities;
}

function parseDividends(contexts: WorkbookContext[]) {
  const dividends: DividendIncome[] = [];
  const issues: ReviewIssue[] = [];
  let hasFeeAssumption = false;

  for (const context of contexts) {
    if (!hasHeaders(context.workbook, COMPANY_ACTION_SHEET, COMPANY_ACTION_HEADERS)) continue;
    const rows = readRows(context.workbook, COMPANY_ACTION_SHEET);
    const headers = rows[0] ?? [];

    rows.slice(1).forEach((values, index) => {
      const row = rowObject(headers, values);
      const symbol = normalizeSymbol(row["股票代码"]);
      if (!symbol) return;

      const grossAmount = Math.abs(asNumber(row["派发红利金额"]));
      const withheld = Math.abs(asNumber(row["费用"]));
      const stockDividendQuantity = Math.abs(asNumber(row["派发红利股"])) + Math.abs(asNumber(row["单位送股数"]));
      const source = sourceId(context.fileName, index + 2);
      if (grossAmount <= 0) {
        if (stockDividendQuantity > 0) {
          issues.push({
            id: `huasheng-stock-action-${context.fileName}-${index + 2}`,
            severity: "warning",
            title: `${symbol} 股票公司行动未计入`,
            detail: "华盛公司行动记录表中识别到送股/红股记录。当前华盛解析器只把现金分红计入利息股息红利所得，送股、拆并股请人工复核成本和数量影响。",
            source,
          });
        }
        return;
      }

      const date = normalizeDate(row["派发日"] || row["支付时间"] || row["登记日"]);
      const currency = asCurrency(row["派红利币种"]);
      const sequence = index + 1;
      if (withheld > 0) hasFeeAssumption = true;

      dividends.push({
        id: `huasheng-dividend-${date}-${sequence}-${currency}-${symbol}`,
        broker: HUASHENG_BROKER,
        date,
        currency,
        symbol,
        securityName: String(row["股票名称"] ?? symbol).trim() || symbol,
        grossAmount: roundMoney(grossAmount),
        taxWithheld: roundMoney(withheld),
        fee: 0,
        source,
        note: "华盛公司行动记录表现金分红；“费用”列暂按分红预扣税/扣费列入境外已纳税额参考，请用资金流水或官方税务文件复核。",
      });
    });
  }

  if (hasFeeAssumption) {
    issues.push({
      id: "huasheng-dividend-fee-withholding-assumption",
      severity: "warning",
      title: "华盛分红费用列需复核",
      detail: "华盛公司行动记录表未把扣除项明确命名为“预扣税”。系统已将“费用”列暂按分红预扣税/扣费计入境外已纳税额抵免参考，正式申报前请和资金流水或官方税务文件核对。",
    });
  }

  return { dividends, issues };
}

function availableYears(activities: TradeActivity[], dividends: DividendIncome[], targetYear?: number) {
  const years = [
    ...activities.map((activity) => activity.date),
    ...dividends.map((dividend) => dividend.date),
  ]
    .map((date) => Number(String(date ?? "").slice(0, 4)))
    .filter((year) => Number.isFinite(year) && year >= 2000);
  if (targetYear) years.push(targetYear);
  return Array.from(new Set(years)).sort((a, b) => a - b);
}

function buildMissingCostRecords(activities: TradeActivity[], targetYear: number, manualCosts: Map<string, number>) {
  const trades: RealizedTrade[] = [];
  const costBasisRequests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];
  const states = new Map<string, { quantity: number; costBasis: number }>();
  const endDate = `${targetYear}-12-31`;

  for (const activity of [...activities].sort(activitySort)) {
    if (activity.date > endDate) break;
    if (activity.excludedFromTaxReplay) continue;
    if (!["buy", "acquire", "transfer_in", "sell"].includes(activity.side)) continue;

    const key = securityKey(activity);
    const state = states.get(key) ?? { quantity: 0, costBasis: 0 };

    if (activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in") {
      state.quantity += activity.quantity;
      state.costBasis += activity.amount;
      states.set(key, state);
      continue;
    }

    if (state.quantity + 1e-7 < activity.quantity) {
      if (activity.date.startsWith(String(targetYear))) {
        const requestId = `huasheng-cost-${targetYear}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`;
        const manualCostBasis = manualCosts.get(requestId);
        if (manualCostBasis !== undefined) {
          trades.push({
            id: `${requestId}-manual`,
            broker: HUASHENG_BROKER,
            sellDate: activity.date,
            sequence: activity.sequence,
            market: activity.market,
            currency: activity.currency,
            symbol: activity.symbol,
            securityName: activity.securityName,
            quantity: activity.quantity,
            proceeds: activity.amount,
            costBasis: manualCostBasis,
            gainLoss: activity.amount - manualCostBasis,
            source: activity.source,
            note: `用户手动补录这笔华盛卖出的总成本：${roundMoney(manualCostBasis)}`,
            useBrokerReportedGainLoss: true,
          });
        } else {
          costBasisRequests.push({
            id: requestId,
            broker: HUASHENG_BROKER,
            sellDate: activity.date,
            sequence: activity.sequence,
            market: activity.market,
            currency: activity.currency,
            symbol: activity.symbol,
            securityName: activity.securityName,
            quantity: activity.quantity,
            trackedQuantity: state.quantity,
            proceeds: activity.amount,
            source: activity.source,
            note: "手动补录这笔华盛卖出的总成本后计入资本利得。",
          });
          issues.push({
            id: `${requestId}-cost-gap`,
            severity: "warning",
            title: `${activity.symbol} 历史成本缺失`,
            detail: `${activity.date} 卖出 ${activity.quantity} 股，但上传的华盛交易记录或月结单中最多只追踪到 ${roundMoney(
              state.quantity,
            )} 股成本；这笔卖出未计入资本利得。请补充更早年度“证券交易记录表”或更早月份 PDF 月结单，也可以在待补成本中手动添加总成本。`,
            source: activity.source,
            taxYear: targetYear,
          });
        }
      }
      state.quantity = 0;
      state.costBasis = 0;
      states.set(key, state);
      continue;
    }

    const costBasis = state.quantity <= 0 ? 0 : (state.costBasis * activity.quantity) / state.quantity;
    state.quantity -= activity.quantity;
    state.costBasis -= costBasis;
    if (Math.abs(state.quantity) < 1e-8) {
      state.quantity = 0;
      state.costBasis = 0;
    }
    states.set(key, state);
  }

  return { trades, costBasisRequests, issues };
}

function parseWorkbookBase(files: HuashengFileInput[]) {
  const contexts = files.map((file) => {
    const context = {
      fileName: file.name,
      workbook: XLSX.read(file.data, { type: "array", cellDates: false }),
    } satisfies WorkbookContext;
    validateWorkbook(context);
    return context;
  });
  const activities = parseTradeActivities(contexts);
  const dividendResult = parseDividends(contexts);
  return {
    activities,
    dividends: dividendResult.dividends,
    issues: dividendResult.issues,
  };
}

function buildHuashengInput(
  activities: TradeActivity[],
  dividends: DividendIncome[],
  openPositions: OpenPosition[],
  baseIssues: ReviewIssue[],
  manualCosts: ManualCostInput[] = [],
  taxYear?: number,
) {
  const parsed = emptyParsedInput();
  const years = availableYears(activities, dividends, taxYear);
  const manualCostLookup = manualCostMap(manualCosts);

  parsed.tradeActivities.push(...activities);
  parsed.dividends.push(...dividends);
  parsed.openPositions.push(...openPositions);
  parsed.issues.push(...baseIssues);

  for (const year of years) {
    const missing = buildMissingCostRecords(activities, year, manualCostLookup);
    parsed.realizedTrades.push(...missing.trades);
    parsed.costBasisRequests.push(...missing.costBasisRequests);
    parsed.issues.push(...missing.issues);
  }

  if (activities.length === 0 && dividends.length === 0 && !baseIssues.some((issue) => issue.severity === "blocking")) {
    parsed.issues.push({
      id: "huasheng-no-tax-records",
      severity: "warning",
      title: "未读取到华盛报税相关记录",
      detail: "请上传华盛证券导出的“证券交易记录表”/“公司行动记录表”Excel，或华盛资本证券 / Valuable Capital PDF 月结单。期初/期末账户资产表只适合人工核对，不会产生报税记录。",
    });
  }

  return parsed;
}

export function parseHuashengWorkbooks(
  files: HuashengFileInput[],
  manualCosts: ManualCostInput[] = [],
  taxYear?: number,
): ParsedInput {
  if (files.length === 0) return emptyParsedInput();
  const base = parseWorkbookBase(files);
  return buildHuashengInput(base.activities, base.dividends, [], base.issues, manualCosts, taxYear);
}

export async function parseHuashengFiles(
  files: HuashengFileInput[],
  manualCosts: ManualCostInput[] = [],
  taxYear?: number,
): Promise<ParsedInput> {
  const workbookFiles = files.filter((file) => /\.xlsx?$/i.test(file.name));
  const pdfFiles = files.filter((file) => /\.pdf$/i.test(file.name));
  const workbookBase = parseWorkbookBase(workbookFiles);
  const pdfBase = pdfFiles.length > 0 ? await parseHuashengPdfFiles(pdfFiles) : emptyParsedInput();
  return buildHuashengInput(
    [...workbookBase.activities, ...pdfBase.tradeActivities],
    [...workbookBase.dividends, ...pdfBase.dividends],
    pdfBase.openPositions,
    [...workbookBase.issues, ...pdfBase.issues],
    manualCosts,
    taxYear,
  );
}
