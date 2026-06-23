import { analyzeTaxScenarioInput, mergeParsedInputs } from "@/lib/tax/calculator";
import { parseFutuWorkbooks, type ManualCostInput } from "@/lib/parsers/futu";
import { parseLongbridgePdfs } from "@/lib/parsers/longbridge";
import { ParserValidationError } from "@/lib/parsers/common";
import type { CostBasisMethod, ParsedInput, RealizedTrade, TaxAnalysis } from "@/lib/tax/types";

export type BrokerId = "futu" | "longbridge";

export interface UploadFileEntry {
  id: string;
  name: string;
  broker: BrokerId;
  file?: File;
}

export interface AnalysisResult {
  parsedInput: ParsedInput;
  byMethod: Record<CostBasisMethod, TaxAnalysis>;
}

function exclusionKey(trade: Pick<RealizedTrade, "broker" | "currency" | "symbol">) {
  return `${trade.broker}::${trade.currency}::${trade.symbol}`;
}

function applyExclusions(input: ParsedInput, excludedKeys: Set<string>): ParsedInput {
  if (excludedKeys.size === 0) return input;
  return {
    ...input,
    realizedTrades: input.realizedTrades.map((trade) => {
      if (!excludedKeys.has(exclusionKey(trade))) return trade;
      return {
        ...trade,
        excluded: true,
        exclusionReason: "用户在页面选择剔除该标的。",
      };
    }),
  };
}

function filterByTaxYear(input: ParsedInput, taxYear: number): ParsedInput {
  const prefix = String(taxYear);
  return {
    ...input,
    dividends: input.dividends.filter((dividend) => dividend.date.startsWith(prefix)),
    openPositions: input.openPositions,
  };
}

export function recomputeAnalyses(
  parsedInput: ParsedInput,
  taxYear: number,
  excludedKeys: Set<string>,
): Record<CostBasisMethod, TaxAnalysis> {
  const scoped = filterByTaxYear(applyExclusions(parsedInput, excludedKeys), taxYear);
  return {
    fifo: analyzeTaxScenarioInput(scoped, taxYear, "fifo"),
    acb: analyzeTaxScenarioInput(scoped, taxYear, "acb"),
  };
}

export async function analyzeUploadedFiles(options: {
  files: UploadFileEntry[];
  taxYear: number;
  password?: string;
  manualCosts?: ManualCostInput[];
  excludedKeys?: Set<string>;
}): Promise<AnalysisResult> {
  const realFiles = options.files.filter((entry) => entry.file);
  if (realFiles.length === 0) {
    throw new ParserValidationError("请先上传至少一份券商文件。");
  }

  const futuFiles: Array<{ name: string; data: ArrayBuffer }> = [];
  const longbridgeFiles: Array<{ name: string; data: ArrayBuffer }> = [];

  for (const entry of realFiles) {
    const file = entry.file;
    if (!file) continue;
    const lower = file.name.toLowerCase();
    if (entry.broker === "futu") {
      if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
        throw new ParserValidationError(`${file.name} 被标记为富途，但富途解析器只接受 Excel 年度报表。`, file.name);
      }
      futuFiles.push({ name: file.name, data: await file.arrayBuffer() });
    } else {
      if (!lower.endsWith(".pdf")) {
        throw new ParserValidationError(`${file.name} 被标记为长桥，但长桥解析器只接受 PDF 月结单。`, file.name);
      }
      longbridgeFiles.push({ name: file.name, data: await file.arrayBuffer() });
    }
  }

  const inputs: ParsedInput[] = [];
  if (futuFiles.length > 0) {
    inputs.push(parseFutuWorkbooks(futuFiles, options.manualCosts ?? []));
  }
  if (longbridgeFiles.length > 0) {
    const parsed = await parseLongbridgePdfs(longbridgeFiles, options.password);
    const blocking = parsed.issues.find((issue) => issue.severity === "blocking");
    if (blocking) {
      throw new ParserValidationError(`${blocking.title}：${blocking.detail}`, blocking.source);
    }
    inputs.push(parsed);
  }

  const parsedInput = mergeParsedInputs(inputs);
  return {
    parsedInput,
    byMethod: recomputeAnalyses(parsedInput, options.taxYear, options.excludedKeys ?? new Set()),
  };
}

export function toExclusionKey(row: Pick<RealizedTrade, "broker" | "currency" | "symbol">) {
  return exclusionKey(row);
}
