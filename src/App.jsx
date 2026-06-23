import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Calculator,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Copy,
  CreditCard,
  DollarSign,
  Download,
  FileText,
  Info,
  Printer,
  Search,
  ShieldCheck,
  Square,
  Table2,
  Trash2,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import {
  BROKER_FILES,
  COST_METHODS,
  DIVIDEND_RMB,
  DIVIDENDS,
  EXCLUDED_RECORDS,
  FLOW_STOCKS,
  FX,
  PNL_ROWS,
  POSITIONS,
  TAX_RATE,
  TAX_YEAR,
} from "./data";
import { analyzeUploadedFiles, recomputeAnalyses } from "./lib/clientAnalyze";
import { ParserValidationError } from "./lib/parsers/common";

const RAW_TOTAL = PNL_ROWS.reduce((sum, row) => sum + row.pnlOriginal * FX[row.market], 0);
const FIFO_TARGET_RMB = 52899.51;
const BASE_RMB = PNL_ROWS.map((row) => row.pnlOriginal * FX[row.market] * (FIFO_TARGET_RMB / RAW_TOTAL));

function fmt(n, digits = 2) {
  return Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(n, digits = 2) {
  return `${n >= 0 ? "+" : "-"}${fmt(n, digits)}`;
}

function cnSigned(n, digits = 2) {
  return `${n >= 0 ? "+" : "-"}${fmt(n, digits)}`;
}

function methodById(methodId) {
  return COST_METHODS.find((method) => method.id === methodId) ?? COST_METHODS[0];
}

function multiplierFor(methodId, idx) {
  const method = methodById(methodId);
  if (method.id === "fifo") return 1;
  return method.factor * (1 + ((((idx * 7) % 5) - 2) * 0.012));
}

function computeRows(methodId) {
  return PNL_ROWS.map((row, idx) => {
    const rmb = BASE_RMB[idx] * multiplierFor(methodId, idx);
    return {
      ...row,
      key: `${row.market}-${row.code}`,
      pnlOriginal: rmb / FX[row.market],
      rmb,
    };
  });
}

function summarize(rows, excludedRowKeys) {
  const capitalGain = rows.reduce((sum, row) => (excludedRowKeys.has(row.key) ? sum : sum + row.rmb), 0);
  const taxable = capitalGain + DIVIDEND_RMB;
  return {
    capitalGain,
    dividend: DIVIDEND_RMB,
    taxable,
    tax: Math.max(taxable, 0) * TAX_RATE,
    includedCount: rows.filter((row) => !excludedRowKeys.has(row.key)).length,
  };
}

function emptySummary() {
  return {
    capitalGain: 0,
    dividend: 0,
    dividendTaxBase: 0,
    dividendWithholdingCredit: 0,
    taxable: 0,
    tax: 0,
    includedCount: 0,
  };
}

function fxForCurrency(currency) {
  if (currency === "USD") return FX.US;
  if (currency === "HKD") return FX.HK;
  return 1;
}

function dividendNetRmbFromDividends(dividends) {
  return (dividends ?? []).reduce((sum, dividend) => {
    return sum + (dividend.grossAmount - dividend.taxWithheld - dividend.fee) * fxForCurrency(dividend.currency);
  }, 0);
}

function summaryFromAnalysis(analysis) {
  if (!analysis) return emptySummary();
  return {
    capitalGain: analysis.summary.capitalGainRmb,
    dividend: dividendNetRmbFromDividends(analysis.dividends),
    dividendTaxBase: analysis.summary.dividend.taxableBaseRmb,
    dividendWithholdingCredit: analysis.summary.dividend.withholdingCreditRmb,
    taxable: analysis.summary.capitalTaxBaseRmb + analysis.summary.dividend.taxableBaseRmb,
    tax: analysis.summary.totalEstimatedTaxRmb,
    includedCount: analysis.symbols.length,
  };
}

function marketCodeFromText(market) {
  const text = String(market ?? "").toUpperCase();
  if (text.includes("美国") || text.includes("US")) return "US";
  return "HK";
}

function currencyToMarket(currency, market) {
  if (currency === "USD") return "US";
  if (currency === "HKD") return "HK";
  return marketCodeFromText(market);
}

function rowsFromAnalysis(analysis) {
  if (!analysis) return [];
  const rows = analysis.symbols.map((symbol) => {
    const market = currencyToMarket(symbol.currency, symbol.market);
    const trades = analysis.realizedTrades.filter(
      (trade) => trade.broker === symbol.broker && trade.currency === symbol.currency && trade.symbol === symbol.symbol,
    );
    return {
      key: `${symbol.broker}::${symbol.currency}::${symbol.symbol}`,
      broker: symbol.broker,
      market,
      code: symbol.symbol,
      name: symbol.securityName,
      currency: symbol.currency,
      quantity: symbol.quantity,
      proceeds: symbol.proceeds,
      costBasis: symbol.costBasis,
      pnlOriginal: symbol.gainLoss,
      rmb: symbol.gainLossRmb,
      transactions: trades,
    };
  });
  const existingKeys = new Set(rows.map((row) => row.key));
  const missingRows = (analysis.costBasisRequests ?? [])
    .map((request) => {
      const key = `${request.broker}::${request.currency}::${request.symbol}`;
      if (existingKeys.has(key)) return null;
      const market = currencyToMarket(request.currency, request.market);
      return {
        key,
        broker: request.broker,
        market,
        code: request.symbol,
        name: request.securityName,
        currency: request.currency,
        quantity: request.quantity,
        proceeds: request.proceeds,
        costBasis: null,
        pnlOriginal: null,
        rmb: null,
        missingCost: true,
        missingCostRequest: request,
        transactions: [],
      };
    })
    .filter(Boolean);
  return [...missingRows, ...rows];
}

function dividendsFromAnalysis(analysis) {
  return analysis?.dividends ?? [];
}

function openPositionsFromAnalysis(analysis) {
  return analysis?.openPositions ?? [];
}

function tradeActivitiesFromAnalysis(analysis) {
  return analysis?.tradeActivities ?? [];
}

function coverageMonths(year, files, tradeActivities, dividends, realizedTrades, openPositions) {
  const activeMonths = new Set();
  const addDate = (date) => {
    const text = String(date ?? "");
    if (!text.startsWith(`${year}-`)) return;
    const month = text.slice(5, 7);
    if (/^\d{2}$/.test(month)) activeMonths.add(month);
  };
  const addAllMonths = () => {
    for (let month = 1; month <= 12; month += 1) activeMonths.add(String(month).padStart(2, "0"));
  };

  (files ?? []).forEach((file) => {
    const name = String(file.name ?? "");
    if (file.type === "年度清单" || name.includes("年度")) {
      addAllMonths();
      return;
    }
    const compactMonth = name.match(new RegExp(`${year}[-_年.]?(0[1-9]|1[0-2])`))?.[1];
    const chineseMonth = name.match(/(?:^|[^0-9])(0?[1-9]|1[0-2])月/)?.[1];
    const month = compactMonth ?? (chineseMonth ? chineseMonth.padStart(2, "0") : null);
    if (month) activeMonths.add(month);
  });

  (tradeActivities ?? []).forEach((activity) => addDate(activity.date));
  (dividends ?? []).forEach((dividend) => addDate(dividend.date));
  (realizedTrades ?? []).forEach((trade) => addDate(trade.sellDate));
  (openPositions ?? []).forEach((position) => addDate(position.asOf));

  return Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return [month, activeMonths.has(month) ? "ok" : "gap"];
  });
}

function methodReportFromAnalysis(analysis) {
  const byMarket = { HK: 0, US: 0 };
  for (const symbol of analysis?.symbols ?? []) {
    byMarket[currencyToMarket(symbol.currency)] += symbol.gainLossRmb;
  }
  const summary = summaryFromAnalysis(analysis);
  return {
    ...summary,
    byMarket,
  };
}

function bestCostMethod(methodSummaries) {
  const fifo = methodSummaries.fifo;
  const acb = methodSummaries.acb;
  const fifoMethod = { id: "fifo", label: "自然年 FIFO", short: "FIFO", summary: fifo };
  const acbMethod = { id: "acb", label: "自然年 ACB", short: "ACB", summary: acb };
  const isTie = Math.abs(fifo.tax - acb.tax) < 0.01;
  const best = fifo.tax <= acb.tax ? fifoMethod : acbMethod;
  const other = best.id === "fifo" ? acbMethod : fifoMethod;
  return {
    best,
    other,
    isTie,
    saving: Math.max(Math.abs(fifo.tax - acb.tax), 0),
  };
}

function classForNumber(n) {
  return n >= 0 ? "pos" : "neg";
}

function guessBroker(fileName) {
  const lower = fileName.toLowerCase();
  if (fileName.includes("富途") || lower.includes("futu")) return "富途证券";
  if (fileName.includes("长桥") || lower.includes("longbridge")) return "长桥证券";
  if (fileName.includes("老虎") || lower.includes("tiger")) return "老虎证券";
  if (lower.includes("ibkr") || lower.includes("interactive")) return "IBKR";
  return "待选择券商";
}

function guessBrokerId(fileName) {
  const broker = guessBroker(fileName);
  return broker === "长桥证券" ? "longbridge" : "futu";
}

function brokerLabel(broker) {
  return broker === "longbridge" ? "长桥" : "富途";
}

function guessFileType(fileName) {
  const lower = fileName.toLowerCase();
  if (fileName.includes("月结") || lower.includes("monthly") || lower.endsWith(".pdf")) return "月结单";
  if (fileName.includes("年度") || lower.includes("annual") || lower.includes("year")) return "年度清单";
  return "待识别";
}

function buildFlows() {
  const dates = ["01-08", "02-19", "03-25", "04-11", "05-20", "06-17", "08-05", "09-12", "10-21", "11-08", "12-16", "12-27"];
  const flows = [];
  FLOW_STOCKS.forEach((stock, i) => {
    const [market, code, name, currency] = stock;
    const base = market === "HK" ? 20 + ((i * 47) % 380) : 95 + ((i * 61) % 720);
    const lot = market === "HK" ? [200, 400, 500, 800, 1000][i % 5] : [10, 20, 30, 50, 80][i % 5];
    [
      ["买入", 0.94, 0],
      ["买入", 1.03, 2],
      ["卖出", 1.12, 5],
    ].forEach(([side, rate, offset], j) => {
      const price = Number((base * rate).toFixed(2));
      const qty = j === 1 ? Math.round(lot * 0.6) : lot;
      const amount = price * qty;
      const fee = Number((amount * 0.0008 + (market === "HK" ? 15 : 1)).toFixed(2));
      flows.push({
        date: `${TAX_YEAR}-${dates[(i + offset) % 12]}`,
        market,
        code,
        name,
        currency,
        side,
        qty,
        price,
        amount,
        fee,
        query: `${code} ${name}`.toLowerCase(),
      });
    });
  });
  return flows.sort((a, b) => a.date.localeCompare(b.date));
}

function txnsFor(idx, row) {
  const s = idx + 1;
  const base = row.market === "HK" ? 40 + ((s * 37) % 360) : 90 + ((s * 53) % 700);
  const lot = row.market === "HK" ? [200, 400, 500, 800, 1000][s % 5] : [10, 20, 30, 50, 80][s % 5];
  const up = row.rmb >= 0;
  const dates = ["02-14", "04-08", "06-21", "09-30", "11-12"];
  return [
    { date: `${TAX_YEAR}-${dates[s % 5]}`, side: "买入", qty: lot, price: Number((base * 0.92).toFixed(2)) },
    { date: `${TAX_YEAR}-${dates[(s + 2) % 5]}`, side: "买入", qty: Math.round(lot * 0.6), price: Number((base * 1.05).toFixed(2)) },
    { date: `${TAX_YEAR}-${dates[(s + 4) % 5]}`, side: "卖出", qty: lot, price: Number((base * (up ? 1.16 : 0.84)).toFixed(2)) },
  ];
}

function Market({ market }) {
  return (
    <span className="mkt">
      <span className={`pin ${market === "HK" ? "hk" : "us"}`} />
      {market}
    </span>
  );
}

function Segmented({ value, options, onChange, className = "" }) {
  return (
    <div className={`seg ${className}`}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "on" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TopBar({ activePage, onNavigate, onUpload, onExportCsv }) {
  const nav = [
    ["workbench", "税务工作台"],
    ["holdings", "持仓与流水"],
    ["report", "申报报告"],
  ];

  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          <ShieldCheck />
        </span>
        <b>TaxCheck</b>
        <span className="sub">海外证券资本利得税</span>
      </div>
      <nav className="topnav" aria-label="主导航">
        {nav.map(([key, label]) => (
          <button key={key} type="button" className={activePage === key ? "on" : ""} onClick={() => onNavigate(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="top-actions">
        <button className="btn" type="button" onClick={onExportCsv}>
          <Download /> 导出 CSV
        </button>
        <button className="btn primary" type="button" onClick={onUpload}>
          <Upload /> 导入券商数据
        </button>
      </div>
    </header>
  );
}

function ContextBar({ year, setYear, methodId, setMethodId, files, excludedRecords, symbolCount }) {
  const method = methodById(methodId);
  return (
    <div className="context">
      <span className="ctx-label">纳税年度</span>
      <div className="yearpick">
        {[2022, 2023, TAX_YEAR].map((item) => (
          <button key={item} type="button" className={year === item ? "on" : ""} onClick={() => setYear(item)}>
            {item}
          </button>
        ))}
      </div>
      <span className="ctx-label context-method-label">计算口径</span>
      <Segmented
        className="method-seg"
        value={methodId}
        options={COST_METHODS.map((item) => ({ value: item.id, label: item.label }))}
        onChange={setMethodId}
      />
      <span className="ctx-chip">
        <span className="dot accent-dot" />
        <b>{method.tag}</b> {method.description}
      </span>
      <span className="ctx-chip">
        <span className="dot" />
        已导入 <b>{files.length}</b> 份券商文件
      </span>
      <span className="ctx-chip">
        覆盖标的 <b>{symbolCount}</b> 只 · 已剔除 <b>{excludedRecords.length}</b> 只
      </span>
      <div className="ctx-spacer" />
      <span className="ctx-note">
        <Info />
        <span>
          年末汇率口径 · <span className="num">{FX.date}</span> {FX.source} · <span className="num">USD {FX.US.toFixed(4)}</span> ·{" "}
          <span className="num">HKD {FX.HK.toFixed(4)}</span>
        </span>
      </span>
    </div>
  );
}

function Kpis({ summary, dividendCount }) {
  return (
    <section className="kpis">
      <div className="kpi feature">
        <div className="k-top">
          <span className="k-label">应缴资本利得税</span>
          <span className="k-ic">
            <DollarSign />
          </span>
        </div>
        <div className="k-val">
          <span className="cur">RMB</span>
          {fmt(summary.tax)}
        </div>
        <div className="k-foot">
          <span className="tag rate">税率 20%</span>按综合所得「财产转让」口径预估
        </div>
      </div>

      <div className="kpi">
        <div className="k-top">
          <span className="k-label">已实现盈亏总额</span>
          <span className="k-ic">
            <TrendingUp />
          </span>
        </div>
        <div className={`k-val ${classForNumber(summary.capitalGain)}`}>{signed(summary.capitalGain)}</div>
        <div className="k-foot">
          <span className="tag up">已折算 RMB</span>含买卖价差，未含未实现浮盈
        </div>
      </div>

      <div className="kpi">
        <div className="k-top">
          <span className="k-label">分红收入（税后净额）</span>
          <span className="k-ic">
            <CreditCard />
          </span>
        </div>
        <div className="k-val">{signed(summary.dividend)}</div>
        <div className="k-foot">已扣预提税 · 来自 {dividendCount} 笔记录</div>
      </div>

      <div className="kpi">
        <div className="k-top">
          <span className="k-label">应税所得合计</span>
          <span className="k-ic">
            <Square />
          </span>
        </div>
        <div className="k-val">{fmt(summary.taxable)}</div>
        <div className="k-foot">已实现盈亏 + 分红 - 剔除标的</div>
      </div>
    </section>
  );
}

function Sidebar({
  files,
  onUpload,
  onRemoveFile,
  onBrokerChange,
  onAnalyze,
  analysisStatus,
  analysisError,
  password,
  onPasswordChange,
  excludedRecords,
  onRestoreExcluded,
}) {
  return (
    <aside>
      <div className="panel">
        <div className="panel-h">
          <h3>
            <FileText /> 券商文件
          </h3>
          <span className="count">{files.length}</span>
        </div>
        <div className="panel-b">
          <button className="drop" type="button" onClick={onUpload}>
            <span className="di">
              <Upload />
            </span>
            <p>拖入或点击上传券商文件</p>
            <span>支持年度清单 / 月结单 · .xlsx .xls .csv .pdf</span>
          </button>
          <ul className="filelist">
            {files.map((file) => (
              <li className="file" key={file.id}>
                <span className="fi">
                  <FileText />
                </span>
                <span className="meta">
                  <b>{file.name}</b>
                  <span>
                    {brokerLabel(file.broker)} · {file.type} · {typeof file.rows === "number" ? `${file.rows} 行` : file.rows}
                  </span>
                  <select className="broker-select" value={file.broker} onChange={(event) => onBrokerChange(file.id, event.target.value)}>
                    <option value="futu">富途</option>
                    <option value="longbridge">长桥</option>
                  </select>
                </span>
                <button className="file-remove" type="button" title="删除文件" onClick={() => onRemoveFile(file.id)}>
                  <Trash2 />
                </button>
                {file.status === "已解析" ? <Check className="ok" /> : null}
              </li>
            ))}
          </ul>
          <label className="field-label">
            <span>长桥 PDF 密码</span>
            <input className="plain-input" value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder="可留空" />
          </label>
          <button className="btn primary full-btn" type="button" onClick={() => onAnalyze()} disabled={analysisStatus === "running"}>
            <Calculator /> {analysisStatus === "running" ? "解析中…" : "解析并计算"}
          </button>
          {analysisError ? <div className="status-message error">{analysisError}</div> : null}
          {analysisStatus === "done" ? <div className="status-message ok-msg">已按 2025 自然年生成 FIFO / ACB 两套结果。</div> : null}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h3>
            <CircleSlash /> 剔除标的
          </h3>
          <span className="count">{excludedRecords.length}</span>
        </div>
        <div className="panel-b">
          <ul className="excl">
            {excludedRecords.map((item) => (
              <li key={item.key ?? `${item.market}-${item.code}`}>
                <span>
                  <span className="code">{item.code}</span>
                  <span className="nm">{item.name}</span>
                </span>
                <span className="reason">{item.tag}</span>
                <button className="x" type="button" title="恢复计入" onClick={() => onRestoreExcluded(item.key ?? item.code)}>
                  <X />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h3>
            <Info /> 计算口径说明
          </h3>
        </div>
        <div className="panel-b">
          <p className="note-card">
            本工具按 <b>个人所得税「财产转让所得」20% 税率</b> 预估。盈亏与分红以 <b>成交日 / 派息日</b> 原币计入，并统一折算为人民币。
            年度边界仅保留 <b>自然年 1/1-12/31</b>，成本法可在 FIFO 与 ACB 之间切换。结果仅供申报参考，不构成税务意见。
          </p>
        </div>
      </div>
    </aside>
  );
}

function PnlTable({
  rows,
  methodId,
  excludedRowKeys,
  toggleRowExcluded,
  summary,
  manualCosts,
  onManualCostChange,
  onSubmitManualCost,
  analysisStatus,
}) {
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [openRow, setOpenRow] = useState(null);
  const method = methodById(methodId);
  const filteredRows = rows.filter((row) => {
    const okQuery = !query || `${row.code} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase());
    const okMarket = market === "all" || row.market === market;
    return okQuery && okMarket;
  });

  return (
    <>
      <div className="toolbar">
        <label className="search">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索股票代码 / 名称…" />
        </label>
        <Segmented
          value={market}
          options={[
            { value: "all", label: "全部市场" },
            { value: "HK", label: "港股" },
            { value: "US", label: "美股" },
          ]}
          onChange={(next) => {
            setMarket(next);
            setOpenRow(null);
          }}
        />
        <div className="tool-spacer" />
        <span className="tcount">
          计入计算 <b>{summary.includedCount}</b> / {rows.length} 只
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>市场</th>
              <th>代码</th>
              <th>名称</th>
              <th className="c">币种</th>
              <th className="r">盈亏（原币）</th>
              <th className="r">年末汇率</th>
              <th className="r">盈亏（RMB）</th>
              <th className="c">计入计算</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, idx) => {
              const excluded = excludedRowKeys.has(row.key);
              const isOpen = openRow === row.key;
              return (
                <React.Fragment key={row.key}>
                  <tr key={row.key} className={`stock-row ${excluded ? "excluded" : ""} ${isOpen ? "open" : ""}`} onClick={() => setOpenRow(isOpen ? null : row.key)}>
                    <td>
                      <Market market={row.market} />
                    </td>
                    <td className="code-cell">{row.code}</td>
                    <td className="stock-nm">
                      <ChevronRight className="caret" />
                      {row.name}
                    </td>
                    <td className="c">
                      <span className="ccy">{row.currency}</span>
                    </td>
                    <td className={`r num pnl ${row.missingCost ? "" : classForNumber(row.pnlOriginal)}`}>
                      {row.missingCost ? `${row.currency} ${fmt(row.proceeds)}` : cnSigned(row.pnlOriginal)}
                    </td>
                    <td className="r num muted">{(FX[row.market] ?? 1).toFixed(4)}</td>
                    <td className={`r num pnl ${row.missingCost ? "pending-text" : classForNumber(row.rmb)}`}>{row.missingCost ? "待补成本" : cnSigned(row.rmb)}</td>
                    <td className="c">
                      <span className="sw-wrap">
                        <button
                          type="button"
                          className={`sw ${excluded ? "off" : ""}`}
                          aria-label={excluded ? "恢复计入" : "剔除计算"}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleRowExcluded(row.key);
                          }}
                        />
                        <span className="sw-label">{excluded ? "剔除" : "计入"}</span>
                      </span>
                    </td>
                  </tr>
                  {isOpen ? (
                    <PnlDetailRow
                      row={row}
                      idx={idx}
                      method={method}
                      manualCosts={manualCosts}
                      onManualCostChange={onManualCostChange}
                      onSubmitManualCost={onSubmitManualCost}
                      analysisStatus={analysisStatus}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="6" className="r">
                已实现盈亏合计（计入部分）
              </td>
              <td className={`r num pnl ${classForNumber(summary.capitalGain)}`}>{cnSigned(summary.capitalGain)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function PnlDetailRow({ row, idx, method, manualCosts, onManualCostChange, onSubmitManualCost, analysisStatus }) {
  if (row.missingCost) {
    const request = row.missingCostRequest;
    const rawValue = manualCosts[request.id] ?? "";
    const numericValue = Number(rawValue);
    const canSubmit = Number.isFinite(numericValue) && numericValue >= 0 && rawValue !== "" && analysisStatus !== "running";
    return (
      <tr className="detail-row">
        <td colSpan="8">
          <div className="detail-wrap">
            <div className="detail-head">
              <b>
                {row.code} · {row.name}
              </b>{" "}
              成本缺失，暂未进入应税盈亏
              <span className="dh-note">
                已识别 {request.sellDate} 卖出 {request.quantity.toLocaleString()} 股，收入 {request.currency} {fmt(request.proceeds)}。补入这批卖出对应的总成本后，会重新生成 FIFO / ACB 结果。
              </span>
            </div>
            <div className="inline-cost">
              <label>
                <span>总成本（{request.currency}）</span>
                <input
                  className="plain-input"
                  value={rawValue}
                  onChange={(event) => onManualCostChange(request.id, event.target.value)}
                  placeholder="例如 298935"
                  inputMode="decimal"
                  onClick={(event) => event.stopPropagation()}
                />
              </label>
              <button
                className="btn primary"
                type="button"
                disabled={!canSubmit}
                onClick={(event) => {
                  event.stopPropagation();
                  onSubmitManualCost(request.id, rawValue);
                }}
              >
                <Calculator /> {analysisStatus === "running" ? "重算中..." : "确认并重算"}
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }
  const txns = row.transactions?.length ? row.transactions : txnsFor(idx, row);
  const isReal = Boolean(row.transactions?.length);
  return (
    <tr className="detail-row">
      <td colSpan="8">
        <div className="detail-wrap">
          <div className="detail-head">
            <b>
              {row.code} · {row.name}
            </b>{" "}
            买卖流水（{row.currency}）
            <span className="dh-note">流水为各口径通用的原始材料；已实现盈亏按当前口径（{method.tag}）匹配成本后得出</span>
          </div>
          <table className="txn-table">
            <thead>
              <tr>
                <th>成交日期</th>
                <th>{isReal ? "来源" : "方向"}</th>
                <th className="r">数量</th>
                <th className="r">{isReal ? "成本" : "成交价"}</th>
                <th className="r">{isReal ? `收益（${row.currency}）` : `成交额（${row.currency}）`}</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((txn) => (
                <tr key={txn.id ?? `${txn.date}-${txn.side}-${txn.qty}`}>
                  <td className="num">{txn.sellDate ?? txn.date}</td>
                  <td>
                    <span className={`side ${isReal ? "se" : txn.side === "买入" ? "bi" : "se"}`}>{isReal ? txn.source : txn.side}</span>
                  </td>
                  <td className="r num">{(txn.quantity ?? txn.qty).toLocaleString()}</td>
                  <td className="r num">{fmt(isReal ? txn.costBasis : txn.price)}</td>
                  <td className={`r num ${isReal ? classForNumber(txn.gainLoss) : ""}`}>{fmt(isReal ? txn.gainLoss : txn.qty * txn.price)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan="4" className="r">
                  当前口径已实现盈亏（{row.currency}）
                </td>
                <td className={`r num ${classForNumber(row.pnlOriginal)}`}>{cnSigned(row.pnlOriginal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </td>
    </tr>
  );
}

function DividendsTable({ dividends }) {
  const rows = (dividends ?? []).map((dividend) => ({
        market: currencyToMarket(dividend.currency),
        code: dividend.symbol,
        name: dividend.securityName,
        perShare: "-",
        withholding: dividend.taxWithheld ? `${fmt((dividend.taxWithheld / Math.max(dividend.grossAmount, 1)) * 100)}%` : "0%",
        netOriginal: `${dividend.currency} ${fmt(dividend.grossAmount - dividend.taxWithheld - dividend.fee)}`,
        rmb: (dividend.grossAmount - dividend.taxWithheld - dividend.fee) * (FX[currencyToMarket(dividend.currency)] ?? 1),
      }));
  const total = rows.reduce((sum, row) => sum + row.rmb, 0);
  return (
    <>
      <div className="toolbar">
        <span className="tcount">
          共 <b>{rows.length}</b> 笔派息记录 · 自然年 1/1-12/31 口径 · 已扣预提税后净额计入
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>市场</th>
              <th>代码</th>
              <th>名称</th>
              <th className="r">每股派息</th>
              <th className="r">预提税率</th>
              <th className="r">税后净额（原币）</th>
              <th className="r">折算 RMB</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.market}-${row.code}`}>
                <td>
                  <Market market={row.market} />
                </td>
                <td className="code-cell">{row.code}</td>
                <td className="stock-nm">{row.name}</td>
                <td className="r num">{row.perShare}</td>
                <td className="r num">{row.withholding}</td>
                <td className="r num">{row.netOriginal}</td>
                <td className="r num">{fmt(row.rmb)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="6" className="r">
                分红收入合计（税后净额）
              </td>
              <td className="r num">{cnSigned(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function TaxSummary({ summary }) {
  const total = Math.abs(summary.capitalGain) + Math.abs(summary.dividend);
  const gainPct = total ? (Math.abs(summary.capitalGain) / total) * 100 : 0;
  const dividendPct = 100 - gainPct;

  return (
    <div className="tax-grid">
      <div className="tax-flow">
        <div className="flow-row">
          <div className="lab">
            <b>已实现资本利得</b>
            <span>买卖价差，按年末汇率折算</span>
          </div>
          <div className={`v ${classForNumber(summary.capitalGain)}`}>{cnSigned(summary.capitalGain)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>分红收入</b>
            <span>税后净额，按年末中间价折算</span>
          </div>
          <div className="v">{cnSigned(summary.dividend)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>剔除标的影响</b>
            <span>ETF / 债券 / 对冲等标的按用户选择排除</span>
          </div>
          <div className="v neg">已排除</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>应税所得额合计</b>
          </div>
          <div className="v">{fmt(summary.taxable)}</div>
        </div>
        <div className="flow-row total">
          <div className="lab">
            <b>应缴资本利得税</b>
            <span>财产转让所得 × 20%</span>
          </div>
          <div className="v">¥{fmt(summary.tax)}</div>
        </div>
      </div>
      <div className="tax-side">
        <h4>所得构成</h4>
        <div className="meter">
          <i style={{ width: `${gainPct.toFixed(1)}%`, background: "var(--gain)" }} />
          <i style={{ width: `${dividendPct.toFixed(1)}%`, background: "var(--accent)" }} />
        </div>
        <div className="legend">
          <div>
            <span className="sq gain-sq" />
            资本利得 <b>{gainPct.toFixed(1)}%</b>
          </div>
          <div>
            <span className="sq accent-sq" />
            分红收入 <b>{dividendPct.toFixed(1)}%</b>
          </div>
        </div>
        <h4 className="fx-title">折算汇率（年末中间价）</h4>
        <div className="legend">
          <div>
            <span className="sq hk-sq" />
            USD / CNY <b>{FX.US.toFixed(4)}</b>
          </div>
          <div>
            <span className="sq us-sq" />
            HKD / CNY <b>{FX.HK.toFixed(4)}</b>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExcludedTable({ records, onRestore }) {
  return (
    <>
      <div className="toolbar">
        <span className="tcount">
          已剔除 <b>{records.length}</b> 只标的，未计入应税所得
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>市场</th>
              <th>代码</th>
              <th>名称</th>
              <th>剔除原因</th>
              <th className="r">原币盈亏</th>
              <th className="r">折算 RMB</th>
              <th className="c">操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((row) => (
              <tr className="excluded" key={row.key ?? `${row.market}-${row.code}`}>
                <td>
                  <Market market={row.market} />
                </td>
                <td className="code-cell">{row.code}</td>
                <td className="stock-nm">{row.name}</td>
                <td>{row.reason}</td>
                <td className="r num">{row.original}</td>
                <td className={`r num ${classForNumber(row.rmb)}`}>{cnSigned(row.rmb)}</td>
                <td className="c">
                  <button className="btn small-btn" type="button" onClick={() => onRestore(row.key ?? row.code)}>
                    恢复计入
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FxTable() {
  return (
    <>
      <div className="toolbar">
        <span className="tcount">
          汇率来源 · <b>中国银行外汇牌价中间价</b> · 年末口径 {FX.date}
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>货币对</th>
              <th>用途</th>
              <th className="r">年末中间价</th>
              <th className="r">年内均价</th>
              <th className="c">应用范围</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="code-cell">USD / CNY</td>
              <td>美股盈亏 · 分红折算</td>
              <td className="r num">{FX.US.toFixed(4)}</td>
              <td className="r num">7.1957</td>
              <td className="c">
                <span className="ccy">年末口径</span>
              </td>
            </tr>
            <tr>
              <td className="code-cell">HKD / CNY</td>
              <td>港股盈亏 · 分红折算</td>
              <td className="r num">{FX.HK.toFixed(4)}</td>
              <td className="r num">0.9216</td>
              <td className="c">
                <span className="ccy">年末口径</span>
              </td>
            </tr>
            <tr>
              <td className="code-cell">CNH 离岸</td>
              <td>对照参考（不参与计算）</td>
              <td className="r num">7.2986</td>
              <td className="r num">7.2034</td>
              <td className="c">
                <span className="ccy">仅参考</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function Workbench({
  year,
  setYear,
  methodId,
  setMethodId,
  rows,
  summary,
  files,
  onUpload,
  onRemoveFile,
  onBrokerChange,
  onAnalyze,
  analysisStatus,
  analysisError,
  password,
  onPasswordChange,
  manualCosts,
  onManualCostChange,
  onSubmitManualCost,
  dividends,
  excludedRecords,
  onRestoreExcluded,
  excludedRowKeys,
  toggleRowExcluded,
}) {
  const [tab, setTab] = useState("pnl");
  const tabs = [
    ["pnl", "盈亏明细", rows.length],
    ["div", "分红记录", dividends.length],
    ["tax", "税务汇总", null],
    ["excl", "剔除记录", excludedRecords.length],
    ["fx", "汇率参数", null],
  ];

  return (
    <>
      <ContextBar year={year} setYear={setYear} methodId={methodId} setMethodId={setMethodId} files={files} excludedRecords={excludedRecords} symbolCount={rows.length} />
      <main className="wrap">
        <Kpis summary={summary} dividendCount={dividends.length} />
        <div className="grid">
          <Sidebar
            files={files}
            onUpload={onUpload}
            onRemoveFile={onRemoveFile}
            onBrokerChange={onBrokerChange}
            onAnalyze={onAnalyze}
            analysisStatus={analysisStatus}
            analysisError={analysisError}
            password={password}
            onPasswordChange={onPasswordChange}
            excludedRecords={excludedRecords}
            onRestoreExcluded={onRestoreExcluded}
          />
          <section className="panel content-panel">
            <div className="tabs">
              {tabs.map(([key, label, count]) => (
                <button key={key} type="button" className={tab === key ? "on" : ""} onClick={() => setTab(key)}>
                  {label}
                  {count !== null ? <span className="badge">{count}</span> : null}
                </button>
              ))}
            </div>
            {tab === "pnl" ? (
              <PnlTable
                rows={rows}
                methodId={methodId}
                excludedRowKeys={excludedRowKeys}
                toggleRowExcluded={toggleRowExcluded}
                summary={summary}
                manualCosts={manualCosts}
                onManualCostChange={onManualCostChange}
                onSubmitManualCost={onSubmitManualCost}
                analysisStatus={analysisStatus}
              />
            ) : null}
            {tab === "div" ? <DividendsTable dividends={dividends} /> : null}
            {tab === "tax" ? <TaxSummary summary={summary} /> : null}
            {tab === "excl" ? <ExcludedTable records={excludedRecords} onRestore={onRestoreExcluded} /> : null}
            {tab === "fx" ? <FxTable /> : null}
          </section>
        </div>
      </main>
    </>
  );
}

function HoldingsPage({ year, openPositions, tradeActivities, realizedTrades, dividends, files }) {
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [side, setSide] = useState("all");
  const [showPositions, setShowPositions] = useState(false);
  const months = useMemo(
    () => coverageMonths(year, files, tradeActivities, dividends, realizedTrades, openPositions),
    [dividends, files, openPositions, realizedTrades, tradeActivities, year],
  );
  const flows = useMemo(() => {
    if (tradeActivities?.length) {
      return tradeActivities.map((activity) => ({
        date: activity.date,
        market: currencyToMarket(activity.currency, activity.market),
        code: activity.symbol,
        name: activity.securityName,
        currency: activity.currency,
        side: activity.side === "sell" ? "卖出" : activity.side === "buy" ? "买入" : activity.side === "transfer_out" ? "转出" : "转入",
        qty: activity.quantity,
        price: activity.unitPrice ?? (activity.quantity ? Math.abs(activity.amount / activity.quantity) : 0),
        amount: activity.grossAmount ?? Math.abs(activity.amount),
        fee: activity.fee ?? 0,
        query: `${activity.symbol} ${activity.securityName}`.toLowerCase(),
      }));
    }
    return [];
  }, [tradeActivities]);
  const positions = useMemo(() => {
    if (openPositions?.length) {
      const enriched = openPositions.map((item) => {
        const market = currencyToMarket(item.currency, item.market);
        const hasCostBasis = Number.isFinite(item.costBasis);
        const hasUnrealized = Number.isFinite(item.unrealizedGainLoss);
        const costBasis = hasCostBasis ? item.costBasis : hasUnrealized ? item.marketValue - item.unrealizedGainLoss : null;
        const last = item.quantity ? item.marketValue / item.quantity : 0;
        const cost = item.quantity && costBasis !== null ? costBasis / item.quantity : null;
        const unrealized = hasUnrealized ? item.unrealizedGainLoss : costBasis !== null ? item.marketValue - costBasis : null;
        const rmb = unrealized === null ? null : unrealized * (FX[market] ?? 1);
        const marketValue = item.marketValue * (FX[market] ?? 1);
        return {
          market,
          code: item.symbol,
          name: item.securityName,
          currency: item.currency,
          qty: item.quantity,
          cost,
          last,
          unrealized,
          rmb,
          marketValue,
        };
      });
      const totalMarketValue = enriched.reduce((sum, item) => sum + item.marketValue, 0);
      return enriched.map((item) => ({ ...item, weight: totalMarketValue ? (item.marketValue / totalMarketValue) * 100 : 0 }));
    }
    return [];
  }, [openPositions]);
  const hasPositionPnl = positions.some((item) => item.rmb !== null);
  const posTotal = positions.reduce((sum, item) => sum + (item.rmb ?? 0), 0);
  const filteredFlows = flows.filter((flow) => {
    const okQuery = !query || flow.query.includes(query.trim().toLowerCase());
    const okMarket = market === "all" || flow.market === market;
    const okSide = side === "all" || flow.side === side;
    return okQuery && okMarket && okSide;
  });

  return (
    <main className="wrap">
      <div className="recon">
        <span className="rtitle">
          <CheckCircle2 /> {year} 数据覆盖
        </span>
        <div className="months">
          {months.map(([month, status]) => (
            <span key={month} className={`mo ${status}`}>
              {month}
            </span>
          ))}
        </div>
        <span className="rnote">
          {files.length} 份文件 · {flows.length} 行流水 · <b>按上传材料生成</b>
        </span>
      </div>

      <div className="sec-h collapsible-h">
        <button className={`section-toggle ${showPositions ? "open" : ""}`} type="button" onClick={() => setShowPositions((value) => !value)}>
          <ChevronRight />
          <span>年末持仓</span>
        </button>
        <span className="pill">
          <AlertCircle /> 未实现盈亏 · 不计入资本利得税
        </span>
        <span className="hint">{showPositions ? "年末估值参考，仅在卖出后才进入应税计算" : `${positions.length} 只持仓，默认收起`}</span>
      </div>
      {showPositions ? (
        <div className="panel">
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>市场</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th className="r">持仓数量</th>
                  <th className="r">平均成本</th>
                  <th className="r">年末价</th>
                  <th className="r">浮动盈亏（原币）</th>
                  <th className="r">浮动盈亏（RMB）</th>
                  <th className="r">仓位占比</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={`${position.market}-${position.code}`}>
                    <td>
                      <Market market={position.market} />
                    </td>
                    <td className="code-cell">{position.code}</td>
                    <td className="stock-nm">{position.name}</td>
                    <td className="r num">{position.qty.toLocaleString()}</td>
                    <td className="r num muted">{position.cost === null ? "-" : position.cost.toFixed(2)}</td>
                    <td className="r num">{position.last.toFixed(2)}</td>
                    <td className={`r num ${position.unrealized === null ? "muted" : classForNumber(position.unrealized)}`}>
                      {position.unrealized === null ? "-" : cnSigned(position.unrealized)}
                    </td>
                    <td className={`r num ${position.rmb === null ? "muted" : classForNumber(position.rmb)}`}>{position.rmb === null ? "-" : cnSigned(position.rmb)}</td>
                    <td className="r num">
                      {position.weight.toFixed(1)}%
                      <span className="bar">
                        <i style={{ width: `${Math.max(position.weight, 3).toFixed(0)}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan="7" className="r">
                    未实现浮盈合计（RMB）
                  </td>
                  <td className={`r num ${hasPositionPnl ? classForNumber(posTotal) : "muted"}`}>{hasPositionPnl ? cnSigned(posTotal) : "-"}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : null}

      <div className="sec-h">
        <h2>全量成交流水</h2>
        <span className="hint">各计算口径通用的原始材料 · 核对券商导入是否完整</span>
      </div>
      <div className="panel">
        <div className="toolbar">
          <label className="search">
            <Search />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索代码 / 名称…" />
          </label>
          <Segmented
            value={market}
            options={[
              { value: "all", label: "全部市场" },
              { value: "HK", label: "港股" },
              { value: "US", label: "美股" },
            ]}
            onChange={setMarket}
          />
          <Segmented
            value={side}
            options={[
              { value: "all", label: "买卖" },
              { value: "买入", label: "买入" },
              { value: "卖出", label: "卖出" },
            ]}
            onChange={setSide}
          />
          <div className="tool-spacer" />
          <span className="tcount">
            显示 <b>{filteredFlows.length}</b> 笔
          </span>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>成交日期</th>
                <th>市场</th>
                <th>代码</th>
                <th>名称</th>
                <th className="c">方向</th>
                <th className="c">币种</th>
                <th className="r">数量</th>
                <th className="r">成交价</th>
                <th className="r">成交额（原币）</th>
                <th className="r">手续费</th>
              </tr>
            </thead>
            <tbody>
              {filteredFlows.map((flow) => (
                <tr key={`${flow.date}-${flow.code}-${flow.side}-${flow.qty}`}>
                  <td className="num muted">{flow.date}</td>
                  <td>
                    <Market market={flow.market} />
                  </td>
                  <td className="code-cell">{flow.code}</td>
                  <td className="stock-nm">{flow.name}</td>
                  <td className="c">
                    <span className={`side ${flow.side === "买入" ? "bi" : "se"}`}>{flow.side}</span>
                  </td>
                  <td className="c">
                    <span className="ccy">{flow.currency}</span>
                  </td>
                  <td className="r num">{flow.qty.toLocaleString()}</td>
                  <td className="r num">{flow.price.toFixed(2)}</td>
                  <td className="r num">{fmt(flow.amount)}</td>
                  <td className="r num muted">{flow.fee.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function ReportPage({ year, methodSummaries, excludedRecords, files, dividends, onCopyReport, copied }) {
  const fifo = methodSummaries.fifo;
  const acb = methodSummaries.acb;
  const { best, other, isTie, saving } = bestCostMethod(methodSummaries);
  const dividendNetRmb = dividendNetRmbFromDividends(dividends);
  const bestColClass = (id) => (!isTie && best.id === id ? "best" : "");
  const bestBadge = (id) => (!isTie && best.id === id ? <span className="badge">推荐</span> : null);

  return (
    <div className="stage">
      <div className="report-actions">
        <button className="btn" type="button" onClick={onCopyReport}>
          <Copy /> {copied ? "已复制申报数字" : "复制申报数字"}
        </button>
        <button className="btn primary" type="button" onClick={() => window.print()}>
          <Printer /> 导出 PDF
        </button>
      </div>
      <div className="sheet">
        <div className="doc-head">
          <div>
            <h1>海外证券资本利得税 · 申报底稿</h1>
            <div className="dh-sub">个人所得税「财产转让所得」口径预估 · 供自行申报参考</div>
          </div>
          <div className="meta">
            纳税年度 <b>{year}</b>
            <br />
            生成日期 <b>2026-06-22</b>
          </div>
        </div>

        <div className="sum">
          <div className="cell lead">
            <div className="lab">应缴资本利得税（推荐口径）</div>
            <div className="val">
              <span className="cur">RMB</span>
              {fmt(best.summary.tax)}
            </div>
            <span className="tag">
              {best.label} · {isTie ? "税额一致" : "税负最优"}
            </span>
          </div>
          <div className="cell">
            <div className="lab">应税所得合计</div>
            <div className="val">
              <span className="cur">¥</span>
              {fmt(best.summary.taxable)}
            </div>
          </div>
          <div className="cell">
            <div className="lab">已实现盈亏</div>
            <div className={`val ${classForNumber(best.summary.capitalGain)}`}>{cnSigned(best.summary.capitalGain)}</div>
          </div>
          <div className="cell">
            <div className="lab">分红收入（税后）</div>
            <div className="val">
              <span className="cur">¥</span>
              {fmt(dividendNetRmb)}
            </div>
          </div>
        </div>

        <h2 className="sh">
          <span className="idx">1</span>计算口径对比 · 同一份材料，两种成本法
        </h2>
        <table className="cmp">
          <thead>
            <tr>
              <th>项目（人民币）</th>
              <th className={`col ${bestColClass("fifo")}`}>
                自然年 · FIFO{bestBadge("fifo")}
              </th>
              <th className={`col ${bestColClass("acb")}`}>
                自然年 · ACB{bestBadge("acb")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="rowlab">
                <b>已实现资本利得</b>
                <br />
                买卖价差，按年末汇率折算
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{cnSigned(fifo.capitalGain)}</td>
              <td className={`col ${bestColClass("acb")}`}>{cnSigned(acb.capitalGain)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>分红收入</b>
                <br />
                税后净额，年末中间价折算
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{cnSigned(dividendNetRmb)}</td>
              <td className={`col ${bestColClass("acb")}`}>{cnSigned(dividendNetRmb)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>应税所得合计</b>
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{fmt(fifo.taxable)}</td>
              <td className={`col ${bestColClass("acb")}`}>{fmt(acb.taxable)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>适用税率</b>
              </td>
              <td className={`col ${bestColClass("fifo")}`}>20%</td>
              <td className={`col ${bestColClass("acb")}`}>20%</td>
            </tr>
            <tr className="total">
              <td>应缴资本利得税</td>
              <td className={`col ${bestColClass("fifo")}`}>¥{fmt(fifo.tax)}</td>
              <td className={`col ${bestColClass("acb")}`}>¥{fmt(acb.tax)}</td>
            </tr>
          </tbody>
        </table>
        <div className="save-note">
          <Check />
          {isTie ? (
            <>
              两种成本法税额一致。两种口径使用完全相同的成交流水，仅成本基准不同。
            </>
          ) : (
            <>
              采用 <b>{best.label}</b> 较 {other.label} 少缴 <b>¥{fmt(saving)}</b>。两种口径使用完全相同的成交流水，仅成本基准不同。
            </>
          )}
        </div>

        <h2 className="sh">
          <span className="idx">2</span>资本利得分项（按市场）
        </h2>
        <table className="lined">
          <thead>
            <tr>
              <th>市场</th>
              <th className={`r ${bestColClass("fifo")}`}>FIFO 口径{bestBadge("fifo")}</th>
              <th className={`r ${bestColClass("acb")}`}>ACB 口径{bestBadge("acb")}</th>
              <th className="r">折算汇率</th>
            </tr>
          </thead>
          <tbody>
            {["HK", "US"].map((market) => (
              <tr key={market}>
                <td>
                  <span className="mkt-tag">{market === "HK" ? "港股 HKD" : "美股 USD"}</span>
                </td>
                <td className={`r num ${classForNumber(fifo.byMarket[market])} ${bestColClass("fifo")}`}>{cnSigned(fifo.byMarket[market])}</td>
                <td className={`r num ${classForNumber(acb.byMarket[market])} ${bestColClass("acb")}`}>{cnSigned(acb.byMarket[market])}</td>
                <td className="r num muted">{FX[market].toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>已实现资本利得合计</td>
              <td className={`r num ${classForNumber(fifo.capitalGain)} ${bestColClass("fifo")}`}>{cnSigned(fifo.capitalGain)}</td>
              <td className={`r num ${classForNumber(acb.capitalGain)} ${bestColClass("acb")}`}>{cnSigned(acb.capitalGain)}</td>
              <td />
            </tr>
          </tfoot>
        </table>

        <h2 className="sh">
          <span className="idx">3</span>分红收入分项（税后净额）
        </h2>
        <table className="lined">
          <thead>
            <tr>
              <th>市场</th>
              <th>代码</th>
              <th>名称</th>
              <th className="r">税后净额</th>
              <th className="r">折算 RMB</th>
            </tr>
          </thead>
          <tbody>
            {dividends.map((dividend) => {
              const market = currencyToMarket(dividend.currency);
              const net = dividend.grossAmount - dividend.taxWithheld - dividend.fee;
              return (
                <tr key={dividend.id}>
                  <td>
                    <span className="mkt-tag">{market === "HK" ? "港股 HKD" : "美股 USD"}</span>
                  </td>
                  <td className="code-cell">{dividend.symbol}</td>
                  <td>{dividend.securityName}</td>
                  <td className="r num">
                    {dividend.currency} {fmt(net)}
                  </td>
                  <td className="r num">{fmt(net * (FX[market] ?? 1))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="4">分红收入合计</td>
              <td className="r num">{cnSigned(dividendNetRmb)}</td>
            </tr>
          </tfoot>
        </table>

        <h2 className="sh">
          <span className="idx">4</span>已剔除标的（不计入应税所得）
        </h2>
        <table className="lined">
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>剔除原因</th>
              <th className="r">折算 RMB</th>
            </tr>
          </thead>
          <tbody>
            {excludedRecords.map((item) => (
              <tr key={`${item.market}-${item.code}`}>
                <td className="code-cell">{item.code}</td>
                <td>{item.name}</td>
                <td className="reason">{item.reason}</td>
                <td className={`r num ${classForNumber(item.rmb)}`}>{cnSigned(item.rmb)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="sh">
          <span className="idx">5</span>数据来源文件
        </h2>
        <table className="lined">
          <thead>
            <tr>
              <th>文件</th>
              <th>类型</th>
              <th className="r">行数</th>
              <th className="c">状态</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr className="file-row" key={file.id}>
                <td className="fn">{file.name}</td>
                <td>{file.type}</td>
                <td className="r num">{typeof file.rows === "number" ? file.rows : "-"}</td>
                <td className="c">
                  <span className="ok-dot" />
                  {file.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="notes">
          <b>计算口径说明.</b> 本底稿按个人所得税「财产转让所得」<b>20% 税率</b> 预估。年度边界为自然年 1/1-12/31。FIFO 按先进先出匹配成本，ACB
          按持仓平均成本匹配。分红按税后净额折算为人民币。
          <div className="disc">免责声明：本工具结果仅供个人申报参考与自查，不构成税务、会计或法律意见。最终申报口径与税额请以主管税务机关要求及专业税务顾问意见为准。</div>
          <div className="sign">
            <div>
              <div className="line">纳税人签字 / 日期</div>
            </div>
            <div>
              <div className="line">复核 / 日期</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const fileInputRef = useRef(null);
  const [page, setPage] = useState("workbench");
  const [year, setYear] = useState(TAX_YEAR);
  const [methodId, setMethodId] = useState("fifo");
  const [files, setFiles] = useState([]);
  const [excludedRowKeys, setExcludedRowKeys] = useState(new Set());
  const [excludedMeta, setExcludedMeta] = useState({});
  const [parsedInput, setParsedInput] = useState(null);
  const [analyses, setAnalyses] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState("idle");
  const [analysisError, setAnalysisError] = useState("");
  const [password, setPassword] = useState("15690339");
  const [manualCosts, setManualCosts] = useState({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!parsedInput) return;
    setAnalyses(recomputeAnalyses(parsedInput, year, excludedRowKeys));
  }, [excludedRowKeys, parsedInput, year]);

  const currentAnalysis = analyses?.[methodId] ?? null;
  const rows = useMemo(() => rowsFromAnalysis(currentAnalysis), [currentAnalysis]);
  const summary = useMemo(() => summaryFromAnalysis(currentAnalysis), [currentAnalysis]);
  const dividends = useMemo(() => dividendsFromAnalysis(currentAnalysis), [currentAnalysis]);
  const openPositions = useMemo(() => openPositionsFromAnalysis(currentAnalysis), [currentAnalysis]);
  const tradeActivities = useMemo(() => tradeActivitiesFromAnalysis(currentAnalysis), [currentAnalysis]);
  const realizedTrades = currentAnalysis?.realizedTrades ?? [];
  const methodSummaries = useMemo(
    () => ({
      fifo: methodReportFromAnalysis(analyses?.fifo),
      acb: methodReportFromAnalysis(analyses?.acb),
    }),
    [analyses],
  );
  const excludedRecords = useMemo(
    () =>
      Array.from(excludedRowKeys)
        .map((key) => excludedMeta[key])
        .filter(Boolean),
    [excludedMeta, excludedRowKeys],
  );

  function triggerUpload() {
    fileInputRef.current?.click();
  }

  function handleFileInput(event) {
    const incoming = Array.from(event.target.files ?? []);
    if (!incoming.length) return;
    setFiles((current) => [
      ...current,
      ...incoming.map((file, idx) => ({
        id: `${Date.now()}-${idx}-${file.name}`,
        name: file.name,
        broker: guessBrokerId(file.name),
        type: guessFileType(file.name),
        rows: "待解析",
        status: "待解析",
        file,
      })),
    ]);
    event.target.value = "";
  }

  function removeFile(fileId) {
    setFiles((current) => current.filter((file) => file.id !== fileId));
  }

  function updateBroker(fileId, broker) {
    setFiles((current) => current.map((file) => (file.id === fileId ? { ...file, broker } : file)));
  }

  function restoreExcluded(key) {
    setExcludedRowKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function toggleRowExcluded(key) {
    const row = rows.find((item) => item.key === key);
    setExcludedRowKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (row) {
          setExcludedMeta((currentMeta) => ({
            ...currentMeta,
            [key]: {
              key,
              market: row.market,
              code: row.code,
              name: row.name,
              reason: "用户手动剔除",
              tag: "手动剔除",
              original: row.missingCost ? `${row.currency} ${fmt(row.proceeds)}` : `${row.currency} ${cnSigned(row.pnlOriginal)}`,
              rmb: row.rmb ?? 0,
            },
          }));
        }
      }
      return next;
    });
  }

  function updateManualCost(id, value) {
    setManualCosts((current) => ({ ...current, [id]: value }));
  }

  async function runAnalysis(manualCostOverrides = {}) {
    setAnalysisStatus("running");
    setAnalysisError("");
    try {
      const effectiveManualCosts = { ...manualCosts, ...manualCostOverrides };
      const manualCostInputs = Object.entries(effectiveManualCosts)
        .map(([id, value]) => ({ id, costBasis: Number(value) }))
        .filter((item) => item.id && Number.isFinite(item.costBasis) && item.costBasis >= 0);
      const result = await analyzeUploadedFiles({
        files,
        taxYear: year,
        password,
        manualCosts: manualCostInputs,
        excludedKeys: excludedRowKeys,
      });
      setParsedInput(result.parsedInput);
      setAnalyses(result.byMethod);
      setFiles((current) =>
        current.map((file) => ({
          ...file,
          rows: file.file ? "已读取" : file.rows,
          status: file.file ? "已解析" : file.status,
        })),
      );
      setAnalysisStatus("done");
    } catch (error) {
      const message =
        error instanceof ParserValidationError || error instanceof Error ? error.message : "解析失败，请检查文件格式和券商选择。";
      setAnalysisError(message);
      setAnalysisStatus("error");
    }
  }

  function submitManualCost(id, value) {
    setManualCosts((current) => ({ ...current, [id]: value }));
    runAnalysis({ [id]: value });
  }

  function exportCsv() {
    const header = ["市场", "代码", "名称", "币种", "成本法", "盈亏原币", "折算汇率", "盈亏RMB", "是否计入"];
    const body = rows.map((row) => [
      row.market,
      row.code,
      row.name,
      row.currency,
      methodById(methodId).label,
      row.missingCost ? "待补成本" : row.pnlOriginal.toFixed(2),
      (FX[row.market] ?? 1).toFixed(4),
      row.missingCost ? "" : row.rmb.toFixed(2),
      excludedRowKeys.has(row.key) ? "否" : "是",
    ]);
    const csv = [header, ...body].map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TaxCheck_${year}_${methodById(methodId).tag}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyReport() {
    const { best, other, isTie, saving } = bestCostMethod(methodSummaries);
    const text = [
      `海外证券资本利得税申报底稿 · 纳税年度 ${year}`,
      `计算口径：${best.label}${isTie ? "（两种成本法税额一致）" : "（推荐，税负最优）"}`,
      `已实现资本利得：¥${fmt(best.summary.capitalGain)}`,
      `分红收入（税后）：¥${fmt(best.summary.dividend)}`,
      `应税所得合计：¥${fmt(best.summary.taxable)}`,
      "适用税率：20%",
      `应缴资本利得税：¥${fmt(best.summary.tax)}`,
      isTie ? "自然年 FIFO 与自然年 ACB 税额一致" : `对比${other.label}应缴 ¥${fmt(other.summary.tax)}，可节省 ¥${fmt(saving)}`,
      `年末汇率：USD ${FX.US.toFixed(4)} / HKD ${FX.HK.toFixed(4)}（${FX.date} ${FX.source}）`,
    ].join("\n");
    navigator.clipboard?.writeText(text).finally(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <>
      <input className="hidden-input" ref={fileInputRef} type="file" multiple accept=".xlsx,.xls,.csv,.pdf" onChange={handleFileInput} />
      <TopBar activePage={page} onNavigate={setPage} onUpload={triggerUpload} onExportCsv={exportCsv} />
      {page === "workbench" ? (
        <Workbench
          year={year}
          setYear={setYear}
          methodId={methodId}
          setMethodId={setMethodId}
          rows={rows}
          summary={summary}
          files={files}
          onUpload={triggerUpload}
          onRemoveFile={removeFile}
          onBrokerChange={updateBroker}
          onAnalyze={runAnalysis}
          analysisStatus={analysisStatus}
          analysisError={analysisError}
          password={password}
          onPasswordChange={setPassword}
          manualCosts={manualCosts}
          onManualCostChange={updateManualCost}
          onSubmitManualCost={submitManualCost}
          dividends={dividends}
          excludedRecords={excludedRecords}
          onRestoreExcluded={restoreExcluded}
          excludedRowKeys={excludedRowKeys}
          toggleRowExcluded={toggleRowExcluded}
        />
      ) : null}
      {page === "holdings" ? (
        <HoldingsPage
          year={year}
          openPositions={openPositions}
          tradeActivities={tradeActivities}
          realizedTrades={realizedTrades}
          dividends={dividends}
          files={files}
        />
      ) : null}
      {page === "report" ? (
        <ReportPage
          year={year}
          methodSummaries={methodSummaries}
          excludedRecords={excludedRecords}
          files={files}
          dividends={dividends}
          onCopyReport={copyReport}
          copied={copied}
        />
      ) : null}
    </>
  );
}
