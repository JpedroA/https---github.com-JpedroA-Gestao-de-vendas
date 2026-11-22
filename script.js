(() => {
  "use strict";

  // ============================================================================
  // MÓDULO 1: PARSER E HIGIENIZAÇÃO DO CSV
  // Responsável por ler o arquivo sujo do sistema de 2009 e devolver dados limpos
  // ============================================================================

  /**
   * Corrige dupla codificação UTF-8 (mojibake).
   * Exemplo real do arquivo: "DESCRIÃ‡ÃƒO" -> "DESCRIÇÃO", "CAMISETA BÃSICA" -> "CAMISETA BÁSICA"
   */
  function fixDoubleUtf8(str) {
    if (!str) return "";
    // Trata o padrão específico "BÃSICA" onde o byte seguinte foi perdido na exportação
    let cleaned = str.replace(/BÃSICA/g, "BÁSICA").replace(/BÃsica/g, "Básica");

    try {
      // Detecta sequências típicas de UTF-8 lido como Latin1/Windows-1252 (ex: Ã‡, Ãƒ, ÃŠ)
      if (/Ã[\x80-\xBF]/.test(cleaned)) {
        const bytes = new Uint8Array(cleaned.length);
        for (let i = 0; i < cleaned.length; i++) {
          bytes[i] = cleaned.charCodeAt(i) & 0xff;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
    } catch (_) {
      // Se alguma linha já estiver em UTF-8 válido misturado, mantém a string original
    }
    return cleaned;
  }

  /**
   * Remove acentos para comparação e busca insensível a acentuação.
   * Exemplo: "CALÇA JEANS" e "Calca Jeans" viram ambas "CALCA JEANS"
   */
  function stripAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  /**
   * Formata nomes de produtos em Capitalização de Título para exibição amigável.
   * Exemplo: "CAMISETA BÁSICA PRETA" -> "Camiseta Básica Preta"
   */
  function toTitleCase(str) {
    const minor = new Set(["de", "da", "do", "das", "dos", "e", "em", "com", "para"]);
    return str
      .toLowerCase()
      .split(/\s+/)
      .map((w, idx) => (idx > 0 && minor.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  }

  /**
   * Converte número no padrão brasileiro ("1.234,50") para Number JavaScript (1234.50).
   */
  function parseBrNumber(raw) {
    if (raw === undefined || raw === null) return NaN;
    const s = String(raw).trim();
    if (!s) return NaN;
    return Number(s.replace(/\./g, "").replace(",", "."));
  }

  /**
   * Valida data DD/MM/YYYY e ajusta datas inexistentes de fim de mês.
   * Exemplo real do arquivo: "31/11/2025" (novembro só tem 30 dias) -> "30/11/2025".
   */
  function parseAndNormalizeDate(rawDate) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(rawDate).trim());
    if (!m) return null;

    let day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month < 1 || month > 12 || day < 1) return null;

    // Descobre o último dia válido daquele mês/ano
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let adjusted = false;
    if (day > maxDay) {
      day = maxDay;
      adjusted = true;
    }

    const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    const brDate = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;

    return {
      isoDate,
      monthKey,
      brDate,
      timestamp: Date.UTC(year, month - 1, day),
      adjusted,
      original: rawDate
    };
  }

  /**
   * Pipeline principal de ingestão: recebe uma lista de textos CSV (permite subir 1 ou vários meses),
   * aplica todas as regras de limpeza e retorna as transações válidas + log de auditoria.
   */
  function ingestCsvTexts(csvTextList) {
    const audit = {
      totalRawLines: 0,
      footerSkipped: 0,
      duplicatesRemoved: 0,
      zeroQtyRemoved: 0,
      datesAdjusted: [],
      collidedCodes: new Set(),
      validTransactions: 0
    };

    const seenExactKeys = new Set(); // Guarda chaves já vistas para eliminar duplicatas exatas
    const rawRows = [];
    const codeToDescriptions = new Map(); // Mapeia cada código às descrições encontradas
    let seqOrder = 0; // Preserva a ordem cronológica/sequencial para rastrear o saldo de estoque

    for (const rawText of csvTextList) {
      const fixedText = fixDoubleUtf8(rawText);
      const lines = fixedText.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Pula a linha de cabeçalho
        if (i === 0 && /^COD;/i.test(line)) continue;

        audit.totalRawLines++;
        const cols = line.split(";");
        if (cols.length < 6) continue;

        const codRaw = cols[0].trim();
        const descRaw = cols[1].trim();
        const dataRaw = cols[2].trim();
        const qtdRaw = cols[3].trim();
        const vlrRaw = cols[4].trim();
        const totRaw = cols[5].trim();
        const estRaw = (cols[6] || "").trim();

        // Regra 1: Ignora linhas de rodapé embutidas (ex: ;;TOTAL SET;;;19.416,70;)
        if (!/^\d+$/.test(codRaw) || /^TOTAL/i.test(dataRaw)) {
          audit.footerSkipped++;
          continue;
        }

        // Regra 2: Padroniza código com 4 dígitos (ex: "124" -> "0124")
        const cod = codRaw.padStart(4, "0");
        const descFixed = fixDoubleUtf8(descRaw);
        const descNorm = stripAccents(descFixed).toUpperCase().replace(/\s+/g, " ").trim();

        const dateInfo = parseAndNormalizeDate(dataRaw);
        if (!dateInfo) continue;

        if (dateInfo.adjusted) {
          audit.datesAdjusted.push(`${dataRaw} → ${dateInfo.brDate} (${descFixed})`);
        }

        const qtd = parseBrNumber(qtdRaw);
        const vlrUnit = parseBrNumber(vlrRaw);
        const total = parseBrNumber(totRaw);
        const estoque = estRaw === "" ? null : parseBrNumber(estRaw);

        // Regra 3: Descarta linha fantasma com QTD = 0 e valor diferente de zero
        if (qtd === 0) {
          audit.zeroQtyRemoved++;
          continue;
        }

        // Regra 4: Deduplicação conservadora (remove apenas linhas 100% idênticas em todos os campos)
        const dedupKey = `${dateInfo.isoDate}|${cod}|${descNorm}|${qtd}|${vlrUnit}|${total}|${estRaw}`;
        if (seenExactKeys.has(dedupKey)) {
          audit.duplicatesRemoved++;
          continue;
        }
        seenExactKeys.add(dedupKey);

        if (!codeToDescriptions.has(cod)) codeToDescriptions.set(cod, new Set());
        codeToDescriptions.get(cod).add(descNorm);

        seqOrder++;
        rawRows.push({
          seq: seqOrder,
          cod,
          descNorm,
          descDisplay: toTitleCase(descFixed),
          dateInfo,
          qtd,
          vlrUnit,
          total,
          estoque
        });
      }
    }

    // Regra 5: Detecta códigos compartilhados por produtos distintos (ex: 0456 = Bermuda Sarja e Boné Aba Reta)
    for (const [cod, descSet] of codeToDescriptions.entries()) {
      if (descSet.size > 1) {
        audit.collidedCodes.add(`${cod} (${Array.from(descSet).join(" vs ")})`);
      }
    }

    // Cria a chave única do produto (productKey): se houver colisão no código, concatena a descrição
    const transactions = rawRows.map((r) => {
      const hasCollision = codeToDescriptions.get(r.cod).size > 1;
      const productKey = hasCollision ? `${r.cod}::${r.descNorm}` : r.cod;
      const productName = hasCollision ? `${r.descDisplay} (Cód. ${r.cod})` : r.descDisplay;
      return { ...r, productKey, productName };
    });

    audit.validTransactions = transactions.length;
    return { transactions, audit };
  }

  // ============================================================================
  // MÓDULO 2: MOTOR ANALÍTICO (MENSAL, CURVA ABC E REPOSIÇÃO)
  // ============================================================================

  /**
   * Recebe as transações limpas e a folga desejada para Curva A (em semanas),
   * calculando todos os indicadores de faturamento, Pareto ABC e sugestão de compra.
   */
  function analyzeStoreData(transactions, safetyWeeksA = 3) {
    if (!transactions.length) {
      return { months: [], products: [], summary: null };
    }

    let minTs = Infinity;
    let maxTs = -Infinity;
    const monthMap = new Map();
    const productMap = new Map();

    // 1. Agrega dados por Mês e por Produto em uma única passada (O(N))
    for (const t of transactions) {
      if (t.dateInfo.timestamp < minTs) minTs = t.dateInfo.timestamp;
      if (t.dateInfo.timestamp > maxTs) maxTs = t.dateInfo.timestamp;

      // Acumulado Mensal
      const mk = t.dateInfo.monthKey;
      if (!monthMap.has(mk)) {
        monthMap.set(mk, {
          monthKey: mk,
          txCount: 0,
          netUnits: 0,
          grossRevenue: 0,
          returnsRevenue: 0,
          netRevenue: 0
        });
      }
      const m = monthMap.get(mk);
      m.txCount += 1;
      m.netUnits += t.qtd;
      m.netRevenue += t.total;
      if (t.total > 0) m.grossRevenue += t.total;
      if (t.total < 0) m.returnsRevenue += t.total; // Devoluções (QTD = -1)

      // Acumulado por Produto
      if (!productMap.has(t.productKey)) {
        productMap.set(t.productKey, {
          productKey: t.productKey,
          cod: t.cod,
          productName: t.productName,
          netUnits: 0,
          netRevenue: 0,
          byMonth: {},
          lastRecordedStock: null,
          lastStockSeq: -1,
          unitsSoldAfterLastStock: 0
        });
      }
      const p = productMap.get(t.productKey);
      p.netUnits += t.qtd;
      p.netRevenue += t.total;
      if (!p.byMonth[mk]) p.byMonth[mk] = { units: 0, revenue: 0 };
      p.byMonth[mk].units += t.qtd;
      p.byMonth[mk].revenue += t.total;

      // Rastreamento de Estoque:
      // Como o sistema só preenche a coluna ESTOQUE em algumas linhas, pegamos o último saldo
      // registrado e subtraímos as unidades vendidas nas linhas posteriores a ele.
      if (t.estoque !== null && !Number.isNaN(t.estoque)) {
        p.lastRecordedStock = t.estoque;
        p.lastStockSeq = t.seq;
        p.unitsSoldAfterLastStock = 0;
      } else if (p.lastStockSeq !== -1 && t.seq > p.lastStockSeq) {
        p.unitsSoldAfterLastStock += t.qtd;
      }
    }

    const months = Array.from(monthMap.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
    const lastMonthKey = months[months.length - 1].monthKey;

    // Calcula automaticamente quantas semanas o arquivo abrange (funciona para 1 semana, 1 mês ou 3 meses)
    const totalDays = Math.max(1, Math.round((maxTs - minTs) / 86400000) + 1);
    const totalWeeks = Math.max(1, totalDays / 7);
    const lastMonthWeeks = 30 / 7;

    // 2. Ordena produtos pelo maior faturamento para calcular a Curva ABC (80% / 15% / 5%)
    const products = Array.from(productMap.values()).sort((a, b) => b.netRevenue - a.netRevenue);
    const positiveTotalRevenue = products
      .filter((p) => p.netRevenue > 0)
      .reduce((acc, p) => acc + p.netRevenue, 0);

    let cumShare = 0;
    for (const p of products) {
      const share = positiveTotalRevenue > 0 && p.netRevenue > 0 ? (p.netRevenue / positiveTotalRevenue) * 100 : 0;
      cumShare += share;
      p.sharePct = share;
      p.cumSharePct = cumShare;

      // Classificação ABC
      if (p.netRevenue <= 0) {
        p.abcClass = "C";
      } else if (cumShare <= 80.5) {
        p.abcClass = "A";
      } else if (cumShare <= 95.5) {
        p.abcClass = "B";
      } else {
        p.abcClass = "C";
      }

      // 3. Cálculo de Giro Semanal e Sugestão de Reposição
      p.weeklyAvg = p.netUnits / totalWeeks;
      const lastMonthUnits = p.byMonth[lastMonthKey]?.units || 0;
      p.lastMonthWeekly = lastMonthUnits / lastMonthWeeks;

      // Alerta de aceleração: sinaliza se o último mês vendeu > 25% acima da média do período
      p.isAccelerating = p.weeklyAvg > 0 && p.lastMonthWeekly > p.weeklyAvg * 1.25;

      p.hasStockRecord = p.lastRecordedStock !== null;
      p.estimatedStock = p.hasStockRecord ? p.lastRecordedStock - p.unitsSoldAfterLastStock : null;

      // Meta de cobertura: Curva A usa a folga escolhida (padrão 3 sem.); Curvas B e C usam 2 semanas
      p.targetWeeks = p.abcClass === "A" ? Number(safetyWeeksA) : 2;
      p.targetUnits = p.weeklyAvg > 0 ? Math.ceil(p.targetWeeks * p.weeklyAvg) : 0;

      if (!p.hasStockRecord) {
        p.coverageWeeks = null;
        p.suggestedOrder = null;
        p.statusType = "warn";
        p.statusLabel = "Sem saldo no CSV";
        p.priorityRank = 3;
      } else if (p.weeklyAvg <= 0) {
        p.coverageWeeks = Infinity;
        p.suggestedOrder = 0;
        p.statusType = "idle";
        p.statusLabel = "Sem giro";
        p.priorityRank = 5;
      } else {
        p.coverageWeeks = p.estimatedStock / p.weeklyAvg;
        p.suggestedOrder = Math.max(0, p.targetUnits - p.estimatedStock);

        if (p.coverageWeeks < 2) {
          p.statusType = "urgent";
          p.statusLabel = "Pedir Urgente (< 2 sem.)";
          p.priorityRank = 1;
        } else if (p.abcClass === "A" && p.coverageWeeks < p.targetWeeks) {
          p.statusType = "warn";
          p.statusLabel = `Reforçar Folga (< ${p.targetWeeks} sem.)`;
          p.priorityRank = 2;
        } else if (p.coverageWeeks > 12) {
          p.statusType = "idle";
          p.statusLabel = "Parado (> 12 sem.)";
          p.priorityRank = 5;
        } else {
          p.statusType = "ok";
          p.statusLabel = "Estoque OK";
          p.priorityRank = 4;
        }
      }
    }

    // Consolida totais gerais para os cartões (KPIs) do topo
    const netRevenue = months.reduce((s, m) => s + m.netRevenue, 0);
    const returnsRevenue = months.reduce((s, m) => s + m.returnsRevenue, 0);
    const netUnits = months.reduce((s, m) => s + m.netUnits, 0);
    const classAItems = products.filter((p) => p.abcClass === "A");
    const classARevenue = classAItems.reduce((s, p) => s + p.netRevenue, 0);
    const reorderItems = products.filter((p) => (p.suggestedOrder || 0) > 0);
    const reorderUnits = reorderItems.reduce((s, p) => s + p.suggestedOrder, 0);

    return {
      months,
      products,
      summary: {
        netRevenue,
        returnsRevenue,
        netUnits,
        totalWeeks,
        classACount: classAItems.length,
        classASharePct: positiveTotalRevenue > 0 ? (classARevenue / positiveTotalRevenue) * 100 : 0,
        reorderCount: reorderItems.length,
        reorderUnits
      }
    };
  }

  // ============================================================================
  // MÓDULO 3: RENDERIZAÇÃO DA INTERFACE (DOM)
  // ============================================================================

  const fmtBRL = (val) =>
    val.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const fmtMonthLabel = (ym) => {
    const [y, m] = ym.split("-");
    const names = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    return `${names[Number(m) - 1]}/${y}`;
  };

  // Estado global em memória da sessão atual
  let state = {
    transactions: [],
    audit: null,
    analysis: null
  };

  /**
   * Recalcula os indicadores com base nos filtros da tela e atualiza todas as tabelas.
   */
  function recomputeAndRender() {
    if (!state.transactions.length) return;

    const safetyWeeksA = Number(document.getElementById("safetyWeeksA").value);
    const classFilter = document.getElementById("filterClass").value;
    const query = stripAccents(document.getElementById("searchInput").value).toUpperCase().trim();

    state.analysis = analyzeStoreData(state.transactions, safetyWeeksA);
    const { months, products, summary } = state.analysis;

    // Alterna do estado vazio para o dashboard completo
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("dashboardContent").style.display = "block";
    document.getElementById("btnExportOrders").disabled = false;

    // Atualiza o banner de auditoria
    const a = state.audit;
    const auditBanner = document.getElementById("auditBanner");
    auditBanner.style.display = "flex";
    document.getElementById("auditSummaryText").textContent =
      `${a.validTransactions} lançamentos válidos processados • ${a.duplicatesRemoved} duplicatas removidas • ${a.zeroQtyRemoved} linha(s) QTD=0 ignoradas • ${a.datesAdjusted.length} data(s) ajustada(s)`;

    const detailsList = [];
    if (a.duplicatesRemoved > 0) {
      detailsList.push(`<li><strong>${a.duplicatesRemoved} vendas duplicadas</strong> (idênticas em data, produto, valor e estoque) foram filtradas para não inflar o faturamento.</li>`);
    }
    if (a.zeroQtyRemoved > 0) {
      detailsList.push(`<li><strong>${a.zeroQtyRemoved} lançamento(s)</strong> com quantidade zero e valor positivo foram descartados.</li>`);
    }
    if (a.datesAdjusted.length > 0) {
      detailsList.push(`<li><strong>Datas corrigidas:</strong> ${a.datesAdjusted.join(", ")}.</li>`);
    }
    if (a.collidedCodes.size > 0) {
      detailsList.push(`<li><strong>Código compartilhado separado:</strong> ${Array.from(a.collidedCodes).join("; ")}.</li>`);
    }
    detailsList.push(`<li><strong>${a.footerSkipped} linha(s)</strong> de totalização embutida no CSV foram ignoradas na soma.</li>`);
    document.getElementById("auditDetails").innerHTML = `<ul>${detailsList.join("")}</ul>`;

    // Preenche os 4 KPIs superiores
    document.getElementById("kpiRevenue").textContent = fmtBRL(summary.netRevenue);
    document.getElementById("kpiReturns").textContent = `Devoluções descontadas: ${fmtBRL(summary.returnsRevenue)}`;
    document.getElementById("kpiUnits").textContent = `${summary.netUnits} un.`;
    document.getElementById("kpiPeriod").textContent = `Janela analisada: ${summary.totalWeeks.toFixed(1)} semanas`;
    document.getElementById("kpiClassA").textContent = `${summary.classACount} produtos`;
    document.getElementById("kpiClassAShare").textContent = `${summary.classASharePct.toFixed(1)}% do faturamento`;
    document.getElementById("kpiReorderCount").textContent = `${summary.reorderCount} ${summary.reorderCount === 1 ? "item" : "itens"}`;
    document.getElementById("kpiReorderUnits").textContent = `${summary.reorderUnits} peças sugeridas para pedido`;

    // Aplica filtros de Curva (A/B/C) e busca por texto
    const filteredProducts = products.filter((p) => {
      if (classFilter !== "ALL" && p.abcClass !== classFilter) return false;
      if (query) {
        const hay = `${p.cod} ${stripAccents(p.productName).toUpperCase()}`;
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    // Renderiza Tabela 1: Reposição (ordenada por urgência e quantidade a pedir)
    const replenishSorted = [...filteredProducts].sort(
      (a, b) => a.priorityRank - b.priorityRank || (b.suggestedOrder || 0) - (a.suggestedOrder || 0) || b.netRevenue - a.netRevenue
    );
    document.getElementById("tbodyReplenish").innerHTML = replenishSorted
      .map((p) => {
        const accelTag = p.isAccelerating
          ? ` <span class="badge status-warn" title="Ritmo do último mês > 25% acima da média">↑ Acelerou</span>`
          : "";
        const covText =
          p.coverageWeeks === null
            ? "—"
            : !Number.isFinite(p.coverageWeeks)
            ? "∞"
            : `${p.coverageWeeks.toFixed(1)} sem.`;
        const estText = p.estimatedStock === null ? "—" : `${p.estimatedStock} un.`;
        const orderText = p.suggestedOrder === null ? "Conferir" : p.suggestedOrder > 0 ? `<strong>+${p.suggestedOrder} un.</strong>` : "0";

        return `<tr>
          <td><span class="badge status-${p.statusType}">${p.statusLabel}</span></td>
          <td>${p.cod}</td>
          <td>${p.productName}${accelTag}</td>
          <td><span class="badge badge-${p.abcClass.toLowerCase()}">Curva ${p.abcClass}</span></td>
          <td class="num">${p.weeklyAvg.toFixed(1)}</td>
          <td class="num">${p.lastMonthWeekly.toFixed(1)}</td>
          <td class="num">${estText}</td>
          <td class="num">${covText}</td>
          <td class="num">${p.targetUnits} un. (${p.targetWeeks}s)</td>
          <td class="num">${orderText}</td>
        </tr>`;
      })
      .join("");

    // Renderiza Tabela 2: Curva ABC
    document.getElementById("tbodyAbc").innerHTML = filteredProducts
      .map((p) => {
        const width = Math.min(100, Math.max(0, p.cumSharePct));
        return `<tr>
          <td><span class="badge badge-${p.abcClass.toLowerCase()}">Classe ${p.abcClass}</span></td>
          <td>${p.cod}</td>
          <td>${p.productName}</td>
          <td class="num">${p.netUnits}</td>
          <td class="num">${fmtBRL(p.netRevenue)}</td>
          <td class="num">${p.sharePct.toFixed(1)}%</td>
          <td>
            <div class="bar-bg"><div class="bar-fill" style="width:${width}%"></div></div>
            ${p.cumSharePct.toFixed(1)}%
          </td>
        </tr>`;
      })
      .join("");

    // Renderiza Tabela 3A: Resumo Consolidado por Mês
    document.getElementById("tbodyMonthlySummary").innerHTML = months
      .map(
        (m) => `<tr>
        <td><strong>${fmtMonthLabel(m.monthKey)}</strong></td>
        <td class="num">${m.txCount}</td>
        <td class="num">${m.netUnits}</td>
        <td class="num">${fmtBRL(m.grossRevenue)}</td>
        <td class="num" style="color:var(--danger-text)">${fmtBRL(m.returnsRevenue)}</td>
        <td class="num"><strong>${fmtBRL(m.netRevenue)}</strong></td>
      </tr>`
      )
      .join("");

    // Renderiza Tabela 3B: Matriz Produto x Mês (colunas dinâmicas conforme os meses no arquivo)
    document.getElementById("theadProductMonthly").innerHTML =
      `<th>Cód.</th><th>Produto</th><th>Curva</th>` +
      months.map((m) => `<th class="num">${fmtMonthLabel(m.monthKey)} (R$ / Un.)</th>`).join("") +
      `<th class="num">Total Período</th>`;

    document.getElementById("tbodyProductMonthly").innerHTML = filteredProducts
      .map((p) => {
        const cols = months
          .map((m) => {
            const cell = p.byMonth[m.monthKey] || { revenue: 0, units: 0 };
            return `<td class="num">${fmtBRL(cell.revenue)} <span style="color:var(--muted)">(${cell.units})</span></td>`;
          })
          .join("");
        return `<tr>
          <td>${p.cod}</td>
          <td>${p.productName}</td>
          <td><span class="badge badge-${p.abcClass.toLowerCase()}">${p.abcClass}</span></td>
          ${cols}
          <td class="num"><strong>${fmtBRL(p.netRevenue)}</strong></td>
        </tr>`;
      })
      .join("");
  }

  // ============================================================================
  // MÓDULO 4: LISTENERS DE UPLOAD, INTERAÇÃO E EXPORTAÇÃO
  // ============================================================================

  /**
   * Lê arquivos selecionados pelo usuário como ArrayBuffer UTF-8 e aciona o pipeline.
   */
  async function handleFiles(fileList) {
    const texts = [];
    for (const file of fileList) {
      const buf = await file.arrayBuffer();
      const text = new TextDecoder("utf-8").decode(buf);
      texts.push(text);
    }
    const { transactions, audit } = ingestCsvTexts(texts);
    state.transactions = transactions;
    state.audit = audit;
    recomputeAndRender();
  }

  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");

  // Clique e Drag & Drop na área de upload
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) handleFiles(e.target.files);
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // Recalcula instantaneamente ao alterar parâmetros ou filtros
  document.getElementById("safetyWeeksA").addEventListener("change", recomputeAndRender);
  document.getElementById("filterClass").addEventListener("change", recomputeAndRender);
  document.getElementById("searchInput").addEventListener("input", recomputeAndRender);

  // Abre/fecha o log detalhado de auditoria
  document.getElementById("btnToggleAudit").addEventListener("click", () => {
    const el = document.getElementById("auditDetails");
    el.style.display = el.style.display === "block" ? "none" : "block";
  });

  // Alterna entre as 3 abas principais
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).style.display = "block";
    });
  });

  // Exporta a lista de compras em CSV UTF-8 com BOM (abre direto no Excel sem quebrar acentos)
  document.getElementById("btnExportOrders").addEventListener("click", () => {
    if (!state.analysis) return;

    const rows = [
      ["CODIGO", "PRODUTO", "CURVA_ABC", "VENDA_SEMANAL", "ESTOQUE_ESTIMADO", "COBERTURA_SEMANAS", "PEDIDO_SUGERIDO_UN", "STATUS"]
    ];

    for (const p of state.analysis.products) {
      if ((p.suggestedOrder || 0) > 0 || p.statusType === "urgent" || p.statusType === "warn") {
        rows.push([
          p.cod,
          p.productName,
          p.abcClass,
          p.weeklyAvg.toFixed(2).replace(".", ","),
          p.estimatedStock ?? "CONFERIR",
          p.coverageWeeks !== null ? p.coverageWeeks.toFixed(1).replace(".", ",") : "CONFERIR",
          p.suggestedOrder ?? "CONFERIR",
          p.statusLabel
        ]);
      }
    }

    const csvContent = "\uFEFF" + rows.map((r) => r.join(";")).join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lista_reposicao_ponto_certo.csv";
    a.click();
    URL.revokeObjectURL(url);
  });

  // ============================================================================
  // MÓDULO 5: DADOS DE EXEMPLO E SUÍTE DE TESTES AUTOMATIZADOS
  // ============================================================================

  // Amostra contendo todos os casos extremos reais encontrados no arquivo da loja
  const SAMPLE_CSV = `COD;DESCRIÃ‡ÃƒO;DATA;QTD;VLR_UNIT;TOTAL;ESTOQUE
0124;CAMISETA BÃSICA PRETA;01/09/2025;5;49,90;249,50;60
124;CAMISETA BÃSICA PRETA;01/09/2025;1;49,90;49,90;
0124;CAMISETA BÁSICA PRETA;09/09/2025;-1;49,90;-49,90;
0124;CAMISETA BÁSICA PRETA;28/11/2025;2;49,90;99,80;11
0124;CAMISETA BÁSICA PRETA;31/11/2025;2;49,90;99,80;
0123;CAMISETA BÃSICA BRANCA;05/09/2025;10;49,90;499,00;
0123;CAMISETA BÁSICA BRANCA;29/11/2025;3;49,90;149,70;34
0201;CALÃ‡A JEANS SKINNY;02/09/2025;3;159,90;479,70;25
0201;CALÇA JEANS SKINNY;19/09/2025;0;159,90;159,90;
0201;Calca Jeans Skinny;27/11/2025;1;159,90;159,90;29
0202;CALÇA JEANS RETA;06/09/2025;1;169,90;169,90;
0202;CALÇA JEANS RETA;06/09/2025;1;169,90;169,90;
0456;BERMUDA SARJA;22/09/2025;3;99,90;299,70;42
456;BONE ABA RETA;14/10/2025;2;59,90;119,80;
456;BONE ABA RETA;08/11/2025;1;59,90;59,90;7
1402;BLAZER ALFAIATARIA;14/10/2025;1;329,90;329,90;58
1402;Blazer Alfaiataria;21/11/2025;1;329,90;280,00;
;;TOTAL NOV;;;2.748,40;`;

  document.getElementById("btnSample").addEventListener("click", () => {
    const { transactions, audit } = ingestCsvTexts([SAMPLE_CSV]);
    state.transactions = transactions;
    state.audit = audit;
    recomputeAndRender();
  });

  // Executa 8 verificações automatizadas para comprovar a integridade das regras
  document.getElementById("btnRunTests").addEventListener("click", () => {
    const out = document.getElementById("testOutput");
    out.style.display = "block";
    const logs = [];
    let passed = 0;

    function assert(cond, msg) {
      if (cond) {
        passed++;
        logs.push(`✔ PASS: ${msg}`);
      } else {
        logs.push(`✘ FAIL: ${msg}`);
      }
    }

    const { transactions, audit } = ingestCsvTexts([SAMPLE_CSV]);
    const analysis = analyzeStoreData(transactions, 3);

    assert(audit.footerSkipped === 1, "Ignora linha de rodapé 'TOTAL NOV'");
    assert(audit.duplicatesRemoved === 1, "Remove linha exatamente duplicada (0202 em 06/09)");
    assert(audit.zeroQtyRemoved === 1, "Remove linha fantasma com QTD = 0 (0201 em 19/09)");
    assert(audit.datesAdjusted.length === 1, "Corrige data inválida 31/11/2025 para 30/11/2025");

    const bermuda = analysis.products.find((p) => p.productKey === "0456::BERMUDA SARJA");
    const bone = analysis.products.find((p) => p.productKey === "0456::BONE ABA RETA");
    assert(Boolean(bermuda && bone), "Separa código 0456 colidido em Bermuda Sarja e Boné Aba Reta");

    const camPreta = analysis.products.find((p) => p.cod === "0124");
    assert(
      camPreta && camPreta.estimatedStock === 9,
      `Calcula estoque atual da Camiseta Preta: 11 - 2 = 9 (obtido: ${camPreta?.estimatedStock})`
    );

    const blazer = analysis.products.find((p) => p.cod === "1402");
    assert(
      blazer && blazer.estimatedStock === 57 && blazer.statusType === "idle",
      "Identifica Blazer Alfaiataria com 57 un. paradas"
    );

    assert(
      Math.abs(analysis.summary.netRevenue - 2418.8) < 0.01,
      `Reconcilia faturamento líquido auditado = R$ 2.418,80 (obtido: R$ ${analysis.summary.netRevenue.toFixed(2)})`
    );

    logs.unshift(`Resultado: ${passed}/8 testes passaram.`);
    out.textContent = logs.join("\n");
  });
})();