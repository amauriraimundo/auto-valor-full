/**
 * AutoValor — FIPE History Proxy
 * ─────────────────────────────────────────────────────────────────────────────
 * Sits between the browser and veiculos.fipe.org.br, bypassing CORS.
 * All routes are read-only GET wrappers around FIPE POST endpoints.
 *
 * Endpoints exposed:
 *   GET /api/referencias
 *       → Returns the list of monthly reference codes (tabelas)
 *
 *   GET /api/preco?tipo=carros&marca=59&modelo=5705&ano=2020-1&tabela=307
 *       → Returns the price of a vehicle for a specific reference month
 *
 *   GET /api/health
 *       → Basic health-check (used by Render / Railway keep-alive)
 *
 * Deploy targets (free tier):
 *   • Render   → https://render.com        (spins down after 15min inactivity — free)
 *   • Railway  → https://railway.app       (5 USD free credit/month — enough for this)
 *   • Cyclic   → https://www.cyclic.sh     (always-on free tier)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3001;
const FIPE_HOST     = 'veiculos.fipe.org.br';
const FIPE_BASE     = '/api/veiculos';
const TIMEOUT_MS    = 10_000;

// Allowed origins for CORS — set '*' for public use or restrict to your domain
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Map friendly tipo strings to FIPE's internal numeric codes
const TIPO_MAP = { carros: 1, motos: 2, caminhoes: 3 };

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** POST JSON to the FIPE API and resolve with the parsed response body. */
function fipePost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const options = {
      hostname: FIPE_HOST,
      port: 443,
      path: `${FIPE_BASE}${path}`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(payload),
        'Accept':         'application/json, text/javascript, */*; q=0.01',
        'Origin':         'https://veiculos.fipe.org.br',
        'Referer':        'https://veiculos.fipe.org.br/',
        'User-Agent':     'Mozilla/5.0 (compatible; AutoValor-Proxy/1.0)',
        'X-Requested-With': 'XMLHttpRequest',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`FIPE parse error: ${data.slice(0, 120)}`));
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('FIPE request timed out'));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Write a JSON response with CORS headers. */
function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
    'Cache-Control':               'public, max-age=3600', // 1h browser cache
  });
  res.end(body);
}

/** Parse query string into a plain object. */
function parseQuery(rawUrl) {
  return Object.fromEntries(new url.URL(rawUrl, 'http://x').searchParams);
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

/**
 * GET /api/referencias
 * Returns array of { Codigo, Mes } objects, most recent first.
 */
async function handleReferencias(res) {
  try {
    const data = await fipePost('/ConsultarTabelaDeReferencia', {});
    if (!Array.isArray(data)) throw new Error('Unexpected response format');
    jsonResponse(res, 200, data);
  } catch (err) {
    jsonResponse(res, 502, { error: err.message });
  }
}

/**
 * GET /api/preco?tipo=carros&marca=59&modelo=5705&ano=2020-1&tabela=307
 *
 * ano format: "{anoModelo}-{codigoTipoCombustivel}"
 *   e.g. "2020-1" = gasolina, "2020-3" = flex, "32000-1" = zero km
 *
 * Returns the standard FIPE vehicle price object.
 */
async function handlePreco(query, res) {
  const { tipo, marca, modelo, ano, tabela } = query;

  // Validate required params
  if (!tipo || !marca || !modelo || !ano || !tabela) {
    jsonResponse(res, 400, { error: 'Missing required params: tipo, marca, modelo, ano, tabela' });
    return;
  }

  const tipoCode = TIPO_MAP[tipo];
  if (!tipoCode) {
    jsonResponse(res, 400, { error: `Invalid tipo "${tipo}". Use: carros, motos, caminhoes` });
    return;
  }

  // Parse anoModelo and combustivel from "2020-1" format
  const [anoModelo, combustivel] = ano.split('-');

  try {
    const data = await fipePost('/ConsultarValorComTodosParametros', {
      codigoTabelaReferencia:    parseInt(tabela, 10),
      codigoMarca:               parseInt(marca,  10),
      codigoModelo:              parseInt(modelo, 10),
      codigoTipoCombustivel:     parseInt(combustivel || '1', 10),
      anoModelo:                 parseInt(anoModelo,   10),
      codigoTipoVeiculo:         tipoCode,
      tipoConsultaVeiculo:       'tradicional',
      modeloCodigoExterno:       '',
    });

    // FIPE returns an object with Valor, CodigoFipe, MesReferencia, etc.
    if (data?.erro) throw new Error(data.erro);
    jsonResponse(res, 200, data);
  } catch (err) {
    jsonResponse(res, 502, { error: err.message });
  }
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = new url.URL(req.url, `http://localhost`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return;
  }

  const query = parseQuery(req.url);

  if (pathname === '/api/health') {
    jsonResponse(res, 200, { status: 'ok', ts: Date.now() });

  } else if (pathname === '/api/referencias') {
    await handleReferencias(res);

  } else if (pathname === '/api/preco') {
    await handlePreco(query, res);

  } else {
    jsonResponse(res, 404, { error: `Unknown route: ${pathname}` });
  }
});

server.listen(PORT, () => {
  console.log(`✅  AutoValor proxy listening on port ${PORT}`);
  console.log(`    Health:      http://localhost:${PORT}/api/health`);
  console.log(`    References:  http://localhost:${PORT}/api/referencias`);
  console.log(`    Price:       http://localhost:${PORT}/api/preco?tipo=carros&marca=59&modelo=5705&ano=2020-1&tabela=307`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
