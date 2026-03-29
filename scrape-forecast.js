#!/usr/bin/env node
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN   = (process.env.TTFORECAST_TOKEN || '').replace(/[\r\n\s]+/g, '');
const BASE    = 'https://petrobras.ttforecast.com.br/api/v1';

if (!TOKEN) { console.error('TTFORECAST_TOKEN não definido'); process.exit(1); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' → ' + url));
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON inválido: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

const DIRS16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];

function degreesToCardinal(deg) {
  if (deg == null) return '—';
  return DIRS16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function normalizeKey(name) {
  return name
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, '')
    .trim();
}

// Calcula direção predominante (média vetorial)
function predominantDir(dirs) {
  if (!dirs.length) return null;
  let sx = 0, sy = 0;
  for (const d of dirs) {
    const r = d * Math.PI / 180;
    sx += Math.sin(r);
    sy += Math.cos(r);
  }
  const mean = Math.atan2(sx, sy) * 180 / Math.PI;
  return ((mean % 360) + 360) % 360;
}

async function main() {
  console.log('Buscando áreas...');
  const areas = await fetchJSON(`${BASE}/areas/`);

  if (!Array.isArray(areas)) {
    throw new Error('Resposta inesperada de /areas/: ' + JSON.stringify(areas).slice(0, 200));
  }
  console.log(`${areas.length} áreas encontradas`);

  const camposData = {};

  for (const area of areas) {
    const uuid = area.id || area.uuid || area.pk;
    const nome = (area.name || area.nome || area.title || uuid).toString();
    if (!uuid) { console.warn('Área sem UUID:', area); continue; }

    process.stdout.write(`  Buscando ${nome}... `);
    let forecast;
    try {
      forecast = await fetchJSON(`${BASE}/${uuid}`);
    } catch (e) {
      console.log('ERRO — ' + e.message);
      continue;
    }

    // Extrai séries temporais
    const ts       = forecast.timestamps || forecast.times || [];
    const wspd     = forecast.wind_speed  || forecast.windspeed || [];
    const wdir     = forecast.wind_direction || forecast.winddirection || [];
    const gusts    = forecast['10_metre_wind_gust_since_previous_post_processing']
                  || forecast.wind_gust || forecast.gusts || [];

    // Agrupa por dia (UTC)
    const dayMap = {};
    ts.forEach((t, i) => {
      const date = String(t).slice(0, 10);
      if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) return;
      if (!dayMap[date]) dayMap[date] = { speeds: [], dirs: [], gusts: [] };
      if (wspd[i]  != null) dayMap[date].speeds.push(Number(wspd[i]));
      if (wdir[i]  != null) dayMap[date].dirs.push(Number(wdir[i]));
      if (gusts[i] != null) dayMap[date].gusts.push(Number(gusts[i]));
    });

    // Converte para estrutura por dia (próximos 5 dias)
    const hoje = new Date().toISOString().slice(0, 10);
    const dias = Object.entries(dayMap)
      .filter(([d]) => d >= hoje)
      .slice(0, 5)
      .map(([data, d]) => {
        const predDeg = predominantDir(d.dirs);
        return {
          data,
          direcaoPredominante:  degreesToCardinal(predDeg),
          direcaoGraus:         predDeg != null ? Math.round(predDeg) : null,
          velocidadeMax:        d.speeds.length ? +Math.max(...d.speeds).toFixed(1) : null,
          velocidadeMin:        d.speeds.length ? +Math.min(...d.speeds).toFixed(1) : null,
          rajadaMax:            d.gusts.length  ? +Math.max(...d.gusts).toFixed(1)  : null,
          rajadaMin:            d.gusts.length  ? +Math.min(...d.gusts).toFixed(1)  : null,
        };
      });

    // Área info do forecast (pode ter mais detalhes)
    const areaInfo = forecast.info?.area || {};
    const nomeFinal = areaInfo.name || nome;
    const key = normalizeKey(nomeFinal);

    camposData[key] = { nome: nomeFinal, uuid, dias };
    console.log(`OK — ${dias.length} dias`);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    unidade: 'ms',   // m/s — verificar se a API já retorna em nós
    campos: camposData,
  };

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, 'forecast.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSalvo: ${Object.keys(camposData).length} campos → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
