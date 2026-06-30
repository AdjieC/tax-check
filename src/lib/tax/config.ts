import type { TaxConfig } from "./types";

export const TAX_YEAR_FX_RATES: Record<
  number,
  { date: string; source: string; fxRates: TaxConfig["fxRates"]; provisional?: boolean }
> = {
  2021: {
    date: "2021-12-31",
    source: "中国外汇交易中心人民币汇率中间价",
    fxRates: { HKD: 0.8176, USD: 6.3757, CNY: 1 },
  },
  2022: {
    date: "2022-12-30",
    source: "中国外汇交易中心人民币汇率中间价",
    fxRates: { HKD: 0.89327, USD: 6.9646, CNY: 1 },
  },
  2023: {
    date: "2023-12-29",
    source: "中国外汇交易中心人民币汇率中间价",
    fxRates: { HKD: 0.90622, USD: 7.0827, CNY: 1 },
  },
  2024: {
    date: "2024-12-31",
    source: "中国外汇交易中心人民币汇率中间价",
    fxRates: { HKD: 0.92604, USD: 7.1884, CNY: 1 },
  },
  2025: {
    date: "2025-12-31",
    source: "中国外汇交易中心人民币汇率中间价",
    fxRates: { HKD: 0.90322, USD: 7.0288, CNY: 1 },
  },
  2026: {
    date: "2026-06-30",
    source: "中国外汇交易中心人民币汇率中间价（2026 年暂按 6 月 30 日最新可用口径，年末汇率公布后需更新）",
    fxRates: { HKD: 0.86855, USD: 6.8109, CNY: 1 },
    provisional: true,
  },
};

export function taxConfigForYear(taxYear: number): TaxConfig {
  return {
    ...defaultTaxConfig,
    fxRates: TAX_YEAR_FX_RATES[taxYear]?.fxRates ?? defaultTaxConfig.fxRates,
  };
}

export const defaultTaxConfig: TaxConfig = {
  taxRate: 0.2,
  fxRates: TAX_YEAR_FX_RATES[2025].fxRates,
  capitalGainMode: "annual-netting",
};
