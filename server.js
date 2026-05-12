require('dotenv').config(); 
process.env.TZ = 'America/Mexico_City'; 

const express = require('express');
const mysql = require('mysql2/promise'); 
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path'); 
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const uploadPath = path.join(process.cwd(), 'public', 'uploads');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
app.use('/uploads', express.static(uploadPath));

const recibosDir = path.join(process.cwd(), 'public', 'recibos_escaneados');
if (!fs.existsSync(recibosDir)) fs.mkdirSync(recibosDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadPath); },
    filename: function (req, file, cb) {
        const extension = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + extension);
    }
});
const upload = multer({ storage: storage });

// 🚨 RESEND ES GLOBAL (Se paga con la suscripción del SaaS)
const resend = new Resend(process.env.RESEND_API_KEY);
const SECRET_KEY = process.env.JWT_SECRET || 'super_secreta_saas_2026';

// 🌐 DOMINIO PRINCIPAL SAAS
const DOMINIO_SAAS = process.env.PUBLIC_URL || 'https://ppservice.icu';

function prepImg(filePath, mimeType) {
    return { inlineData: { data: Buffer.from(fs.readFileSync(filePath)).toString("base64"), mimeType } };
}

const pool = mysql.createPool({ 
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    waitForConnections: true, connectionLimit: 20, timezone: '-06:00', dateStrings: true
});

pool.on('connection', (connection) => {
    connection.query("SET time_zone = '-06:00';", (err) => { if (err) console.error("Error zona horaria:", err); });
});

// ==============================================================================
// 🏗️ AUTO-CONSTRUCCIÓN DE LA ARQUITECTURA SAAS Y BD
// ==============================================================================
pool.getConnection().then(async (connection) => {
    console.log(`🧠 Cerebro SaaS FINAL en línea | Dominio base: ${DOMINIO_SAAS}`);
    
    await connection.query(`CREATE TABLE IF NOT EXISTS empresas (id INT AUTO_INCREMENT PRIMARY KEY, nombre_comercial VARCHAR(255), plan VARCHAR(50) DEFAULT 'basico', estado VARCHAR(50) DEFAULT 'activo', llaves_api JSON, fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await connection.query(`CREATE TABLE IF NOT EXISTS sucursales (id INT AUTO_INCREMENT PRIMARY KEY, empresa_id INT, nombre VARCHAR(255), direccion TEXT, FOREIGN KEY (empresa_id) REFERENCES empresas(id))`).catch(() => {});

    await connection.query(`CREATE TABLE IF NOT EXISTS apartados (id INT AUTO_INCREMENT PRIMARY KEY, empresa_id INT, sucursal_id INT, cliente VARCHAR(255), descripcion_prendas TEXT, total DECIMAL(10,2), enganche DECIMAL(10,2), resta DECIMAL(10,2), items JSON, estado VARCHAR(50) DEFAULT 'activo', fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await connection.query(`CREATE TABLE IF NOT EXISTS gastos_fijos (id INT AUTO_INCREMENT PRIMARY KEY, empresa_id INT, sucursal_id INT, concepto VARCHAR(255), monto DECIMAL(10,2), fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await connection.query(`CREATE TABLE IF NOT EXISTS pedidos_web (id INT AUTO_INCREMENT PRIMARY KEY, empresa_id INT, cliente VARCHAR(255), info_envio TEXT, total DECIMAL(10,2), estado VARCHAR(50), guia_rastreo VARCHAR(255), paqueteria VARCHAR(100), metodo_pago VARCHAR(50), id_transaccion VARCHAR(255), fecha_compra TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});
    await connection.query(`CREATE TABLE IF NOT EXISTS configuracion_tienda (parametro VARCHAR(255), empresa_id INT, valor VARCHAR(255), PRIMARY KEY (parametro, empresa_id))`).catch(() => {});

    const tablasMultiTenant = ['productos', 'historial_cortes', 'staff', 'bitacora_movimientos', 'clientes', 'historial_cashback', 'cortes', 'chips_nfc'];
    for (const tabla of tablasMultiTenant) { await connection.query(`ALTER TABLE ${tabla} ADD COLUMN empresa_id INT`).catch(() => {}); }
    const tablasConSucursal = ['historial_cortes', 'bitacora_movimientos', 'staff', 'apartados', 'gastos_fijos'];
    for (const tabla of tablasConSucursal) { await connection.query(`ALTER TABLE ${tabla} ADD COLUMN sucursal_id INT`).catch(() => {}); }

    await connection.query(`ALTER TABLE historial_cortes ADD COLUMN detalles JSON`).catch(() => {});
    await connection.query(`ALTER TABLE staff ADD COLUMN descuento_cliente DECIMAL(10,2) DEFAULT 0`).catch(() => {});
    await connection.query(`ALTER TABLE bitacora_movimientos ADD COLUMN metodo_pago VARCHAR(255) DEFAULT 'Efectivo'`).catch(() => {});
    await connection.query(`ALTER TABLE bitacora_movimientos MODIFY COLUMN metodo_pago VARCHAR(255) DEFAULT 'Efectivo'`).catch(() => {});
    await connection.query(`ALTER TABLE historial_cortes ADD COLUMN ventas_efectivo DECIMAL(10,2) DEFAULT 0`).catch(() => {});
    await connection.query(`ALTER TABLE historial_cortes ADD COLUMN ventas_tarjeta DECIMAL(10,2) DEFAULT 0`).catch(() => {});
    await connection.query(`ALTER TABLE historial_cortes ADD COLUMN ventas_transferencia DECIMAL(10,2) DEFAULT 0`).catch(() => {});
    await connection.query(`ALTER TABLE historial_cashback MODIFY COLUMN tipo VARCHAR(50)`).catch(() => {});
    await connection.query(`ALTER TABLE clientes MODIFY COLUMN nivel_vip VARCHAR(50)`).catch(() => {});

    connection.release();
}).catch(err => console.error('❌ Error Crítico BD:', err));

// ==============================================================================
// 🛡️ MIDDLEWARE DE SEGURIDAD SAAS
// ==============================================================================
const validarAccesoSaaS = async (req, res, next) => {
    // 🚨 Las rutas de los webhooks son públicas porque las llama el proveedor
    const rutasPublicas = ['/api/web/catalogo', '/api/web/crear-pedido', '/api/oficina/login', '/api/pos/login', '/api/bodega/login', '/api/web/storefront'];
    
    // Si la ruta inicia con el webhook, déjala pasar
    if (req.path.startsWith('/api/pos/terminal/webhook/') || rutasPublicas.includes(req.path)) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ exito: false, error: 'Acceso denegado. Token faltante.' });

    try {
        const token = authHeader.split(' ')[1];
        const decodificado = jwt.verify(token, SECRET_KEY);
        const [empresa] = await pool.query('SELECT estado FROM empresas WHERE id = ?', [decodificado.empresa_id]);
        if (empresa.length === 0 || empresa[0].estado !== 'activo') return res.status(403).json({ exito: false, error: 'Suscripción suspendida.' });
        req.usuario = decodificado; 
        next();
    } catch (error) { return res.status(401).json({ exito: false, error: 'Token inválido o expirado.' }); }
};
app.use('/api', validarAccesoSaaS);

// ==============================================================================
// 💌 MOTOR DE CORREOS VIP (Sigue siendo Global)
// ==============================================================================
async function enviarCorreoVIP(email, nombre, qrHash, nivel, bono = 0) {
    if (!email) return;
    try {
        const qrImageUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qrHash)}&size=400&margin=1&dark=000000&light=ffffff`;
        const hoy = new Date(); const emitido = `${hoy.getDate().toString().padStart(2,'0')}/${(hoy.getMonth()+1).toString().padStart(2,'0')}/${hoy.getFullYear()}`;
        hoy.setFullYear(hoy.getFullYear() + 1); const vence = `${hoy.getDate().toString().padStart(2,'0')}/${(hoy.getMonth()+1).toString().padStart(2,'0')}/${hoy.getFullYear()}`;
        
        let bgGradient = 'linear-gradient(135deg, #e0e0e0 0%, #ffffff 40%, #b0b0b0 100%)'; let bgColor = '#e0e0e0'; let textColor = '#010101'; let logoFile = 'logo_negro.png';
        if (nivel === 'oro') { bgGradient = 'linear-gradient(135deg, #bf953f 0%, #fcf6ba 40%, #b38728 100%)'; bgColor = '#d4af37'; } 
        else if (nivel === 'titanio') { bgGradient = 'linear-gradient(135deg, #333333 0%, #555555 50%, #1a1a1a 100%)'; bgColor = '#222222'; textColor = '#fffffe'; logoFile = 'logo_blanco.png'; }
        
        let logoUrl = `${DOMINIO_SAAS}/uploads/${logoFile}`;
        let msjBono = bono > 0 ? `<div style="font-size: 15px; margin-bottom: 25px; color: #2ecc71; font-weight: bold;">+ $${bono} MXN APLICADOS</div>` : '';
        
        const htmlContent = `<!DOCTYPE html><html lang="es"><body><div style="text-align: center;"><img src="${logoUrl}" width="120"/><br><h2>${nombre}</h2><img src="${qrImageUrl}" width="150" /><p>ID: ${qrHash}</p>${msjBono}</div></body></html>`;
        await resend.emails.send({ from: 'SaaS VIP <ventas@jpjeansvip.com>', to: email, subject: `Tu Tarjeta VIP - Nivel ${nivel.toUpperCase()}`, html: htmlContent });
    } catch (err) { console.error("Error correo VIP:", err); }
}

// ==============================================================================
// 🔑 AUTENTICACIÓN SAAS
// ==============================================================================
app.post('/api/oficina/login', async (req, res) => { 
    const [rows] = await pool.query('SELECT id, empresa_id, sucursal_id, rol, nombre FROM staff WHERE usuario=? AND password=? AND rol="admin_oficina"', [req.body.usuario, req.body.password]);
    if (rows.length) res.json({ exito: true, nombre: rows[0].nombre, token: jwt.sign({ id_staff: rows[0].id, empresa_id: rows[0].empresa_id, sucursal_id: rows[0].sucursal_id, rol: rows[0].rol }, SECRET_KEY, { expiresIn: '7d' }) }); else res.status(401).json({ exito: false });
});

app.post('/api/pos/login', async (req, res) => { 
    const [rows] = await pool.query('SELECT id, empresa_id, sucursal_id, rol, nombre FROM staff WHERE usuario=? AND password=? AND rol="vendedor_pos"', [req.body.usuario, req.body.password]);
    if (rows.length) res.json({ exito: true, nombre: rows[0].nombre, token: jwt.sign({ id_staff: rows[0].id, empresa_id: rows[0].empresa_id, sucursal_id: rows[0].sucursal_id, rol: rows[0].rol }, SECRET_KEY, { expiresIn: '365d' }) }); else res.status(401).json({ exito: false });
});

app.post('/api/bodega/login', async (req, res) => { 
    const [rows] = await pool.query('SELECT id, empresa_id, sucursal_id, rol, nombre FROM staff WHERE usuario=? AND password=? AND rol="operador_bodega"', [req.body.usuario, req.body.password]);
    if (rows.length) res.json({ exito: true, nombre: rows[0].nombre, token: jwt.sign({ id_staff: rows[0].id, empresa_id: rows[0].empresa_id, sucursal_id: rows[0].sucursal_id, rol: rows[0].rol }, SECRET_KEY, { expiresIn: '30d' }) }); else res.status(401).json({ exito: false });
});

// ==============================================================================
// ⚙️ LLAVES API DINÁMICAS
// ==============================================================================
app.get('/api/oficina/llaves-api', async (req, res) => {
    try {
        const [empresa] = await pool.query('SELECT llaves_api FROM empresas WHERE id = ?', [req.usuario.empresa_id]);
        res.json({ exito: true, llaves: empresa[0].llaves_api || {} });
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/api/oficina/llaves-api', async (req, res) => {
    try {
        await pool.query('UPDATE empresas SET llaves_api = ? WHERE id = ?', [JSON.stringify(req.body.llaves), req.usuario.empresa_id]);
        res.json({ exito: true, mensaje: 'Llaves actualizadas correctamente.' });
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

// ==============================================================================
// 1. APLICACIÓN PÚBLICA WEB
// ==============================================================================
app.get('/api/web/catalogo', async (req, res) => {
    try {
        const { genero, tipo, corte, rebajas, novedades, limit, empresa_id } = req.query;
        if (!empresa_id) return res.status(400).json({exito: false, error: 'empresa_id requerido'});
        let query = `SELECT p.id, p.sku, p.nombre_web AS nombre, p.precio_venta, p.en_rebaja, p.precio_rebaja, p.url_foto_principal, p.urls_fotos_extra, c.nombre_corte, p.tallas, p.descripcion, p.categoria, p.tipo FROM productos p LEFT JOIN cortes c ON p.id_corte = c.id WHERE p.estado = 'activo' AND p.estado_web = 1 AND p.stock_bodega > 0 AND p.empresa_id = ?`;
        const params = [empresa_id];
        if (genero) { query += ` AND p.categoria = ?`; params.push(genero); }
        if (tipo) { query += ` AND p.tipo = ?`; params.push(tipo); }
        if (corte) { query += ` AND c.nombre_corte = ?`; params.push(corte); }
        if (rebajas === 'true') query += ` AND p.en_rebaja = 1`;
        if (novedades === 'true') query += ` ORDER BY p.id DESC`; else query += ` ORDER BY RAND()`;
        if (limit) { query += ` LIMIT ?`; params.push(Number(limit)); }

        const [productos] = await pool.query(query, params);
        const productosProcesados = productos.map(p => {
            let tallasArr = [];
            if (p.tallas) { try { tallasArr = p.tallas.startsWith('[') ? JSON.parse(p.tallas) : p.tallas.split(',').map(t => t.trim()); } catch(e) { tallasArr = [p.tallas.toString()]; } }
            let imgFull = p.url_foto_principal ? (p.url_foto_principal.startsWith('http') ? p.url_foto_principal : `${DOMINIO_SAAS}${p.url_foto_principal}`) : null;
            return { ...p, tallas_array: tallasArr, url_foto_principal: imgFull };
        });
        res.json({ exito: true, productos: productosProcesados });
    } catch (e) { res.status(500).json({ exito: false, error: 'Error web' }); }
});

app.post('/api/web/crear-pedido', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const { carrito, datosEnvio, metodo_pago, id_transaccion, total, codigo_creador, empresa_id } = req.body;
        if (!empresa_id) throw new Error("Empresa no identificada");
        const infoEnvio = `${datosEnvio.email} | Tel: ${datosEnvio.telefono} | Dir: ${datosEnvio.calle} ${datosEnvio.numero}, Col. ${datosEnvio.colonia}, CP ${datosEnvio.cp}. ${datosEnvio.ciudad}, ${datosEnvio.estado}`;
        const estadoInicial = metodo_pago === 'OXXO Pendiente' ? 'pendiente_oxxo' : 'preparando_envio';
        const [resPedido] = await connection.query(`INSERT INTO pedidos_web (empresa_id, cliente, info_envio, total, estado, metodo_pago, id_transaccion) VALUES (?, ?, ?, ?, ?, ?, ?)`, [empresa_id, datosEnvio.nombre, infoEnvio, total, estadoInicial, metodo_pago, id_transaccion]);
        const idPedido = resPedido.insertId;

        let resumen = `[PEDIDO WEB #${idPedido}] `; let piezas = 0;
        for(let item of carrito) {
            const [pRows] = await connection.query('SELECT tallas FROM productos WHERE id = ? AND empresa_id = ?', [item.id, empresa_id]);
            let tallasAct = [];
            if (pRows.length > 0 && pRows[0].tallas) {
                try { tallasAct = typeof pRows[0].tallas === 'string' ? JSON.parse(pRows[0].tallas) : pRows[0].tallas; } catch(e){}
                let tIndex = tallasAct.findIndex(t => t.talla === item.talla || (t.nombre && t.nombre === item.talla));
                if (tIndex !== -1 && tallasAct[tIndex].cantidad !== undefined) tallasAct[tIndex].cantidad = Math.max(0, tallasAct[tIndex].cantidad - item.cantidad);
            }
            await connection.query('UPDATE productos SET stock_bodega = stock_bodega - ?, tallas = ? WHERE id = ? AND empresa_id = ?', [item.cantidad, JSON.stringify(tallasAct), item.id, empresa_id]);
            resumen += `${item.cantidad}x [SKU: ${item.sku || 'N/A'}] ${item.nombre} (Talla: ${item.talla}). `; piezas += item.cantidad;
        }

        if (codigo_creador) resumen += `| Creador: ${codigo_creador}`;
        if (estadoInicial !== 'pendiente_oxxo') {
            await connection.query(`INSERT INTO bitacora_movimientos (empresa_id, tipo, descripcion, monto, cantidad, metodo_pago) VALUES (?, 'VENTA_WEB', ?, ?, ?, ?)`, [empresa_id, resumen, total, piezas, `${metodo_pago} (ID: ${id_transaccion})`]);
        }
        await connection.commit(); res.json({ exito: true, id_pedido: idPedido });
    } catch(e) { await connection.rollback(); res.status(500).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

// ==============================================================================
// 2. APLICACIÓN BODEGA
// ==============================================================================
app.get('/api/bodega/inventario', async (req, res) => { 
    try { const [productos] = await pool.query(`SELECT id, sku, nombre, nombre_web, categoria, tallas, stock_bodega, estado_web, en_rebaja, precio_venta, precio_rebaja, url_foto_principal FROM productos WHERE estado = 'activo' AND empresa_id = ? ORDER BY id DESC`, [req.usuario.empresa_id]); res.json({ exito: true, productos }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.post('/api/bodega/ingreso', async (req, res) => {
    try { await pool.query('UPDATE productos SET stock_bodega = stock_bodega + ? WHERE id = ? AND empresa_id = ?', [req.body.cantidad, req.body.id_producto, req.usuario.empresa_id]); await pool.query('INSERT INTO bitacora_movimientos (empresa_id, tipo, descripcion, cantidad) VALUES (?, "INGRESO_BODEGA", ?, ?)', [req.usuario.empresa_id, `Entrada: ${req.body.nota}`, req.body.cantidad]); res.json({ exito: true }); } catch(e) { res.status(500).json({ exito: false }); }
});

app.get('/api/bodega/pedidos-pendientes', async (req, res) => { 
    const [pedidos] = await pool.query('SELECT * FROM pedidos_web WHERE estado="preparando_envio" AND empresa_id=? ORDER BY fecha_compra ASC', [req.usuario.empresa_id]); res.json({ exito: true, pedidos }); 
});

app.post('/api/bodega/despachar/:id_pedido', async (req, res) => { 
    try { await pool.query('UPDATE pedidos_web SET estado="enviado", guia_rastreo=?, paqueteria=? WHERE id=? AND empresa_id=?', [req.body.guia_rastreo, req.body.paqueteria, req.params.id_pedido, req.usuario.empresa_id]); await pool.query('INSERT INTO bitacora_movimientos (empresa_id, tipo, descripcion) VALUES (?, "DESPACHO_BODEGA", ?)', [req.usuario.empresa_id, `Pedido #${req.params.id_pedido} despachado por ${req.body.paqueteria}`]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); }
});

// ==============================================================================
// 3. APLICACIÓN PUNTO DE VENTA (POS) Y CAMBIOS
// ==============================================================================
app.get('/api/pos/catalogo', async (req, res) => { 
    try { const [productos] = await pool.query(`SELECT id, sku, nombre, precio_venta, en_rebaja, precio_rebaja, stock_bodega, tallas, url_foto_principal FROM productos WHERE estado = 'activo' AND empresa_id = ?`, [req.usuario.empresa_id]); res.json({ exito: true, productos }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.get('/api/pos/vip/consultar/:qr', async (req, res) => {
    try { const [rows] = await pool.query('SELECT id, nombre, email, saldo_cashback, compras_totales, nivel_vip FROM clientes WHERE qr_hash = ? AND empresa_id = ?', [req.params.qr, req.usuario.empresa_id]); if(rows.length > 0) res.json({ exito: true, registrado: true, cliente: rows[0] }); else res.json({ exito: true, registrado: false, mensaje: 'Tarjeta virgen' }); } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/api/pos/vip/registrar', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const { nombre, email, telefono, qr_hash } = req.body; if (!qr_hash) throw new Error("Falta el código QR físico.");
        const [conf] = await connection.query("SELECT valor FROM configuracion_tienda WHERE parametro = 'bono_bienvenida' AND empresa_id = ?", [req.usuario.empresa_id]);
        let bono = conf.length > 0 ? parseFloat(conf[0].valor) : 150; 
        const [result] = await connection.query(`INSERT INTO clientes (empresa_id, nombre, email, telefono, saldo_cashback, compras_totales, nivel_vip, qr_hash) VALUES (?, ?, ?, ?, ?, 0, 'plata', ?)`, [req.usuario.empresa_id, nombre, email, telefono, bono, qr_hash]);
        await connection.query(`INSERT INTO historial_cashback (empresa_id, id_cliente, monto, tipo, descripcion) VALUES (?, ?, ?, 'bono_bienvenida', 'Bono Inicial - Nivel Plata')`, [req.usuario.empresa_id, result.insertId, bono]);
        await connection.commit(); enviarCorreoVIP(email, nombre, qr_hash, 'plata', bono); res.json({ exito: true, qr_hash: qr_hash, saldo: bono, nivel: 'plata' });
    } catch (e) { await connection.rollback(); res.status(500).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/vip/traspasar', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const { viejo_qr, nuevo_qr, nuevo_nivel } = req.body; const [cliente] = await connection.query('SELECT * FROM clientes WHERE qr_hash = ? AND empresa_id = ?', [viejo_qr, req.usuario.empresa_id]);
        if (cliente.length === 0) throw new Error("La tarjeta vieja no existe.");
        await connection.query('UPDATE clientes SET qr_hash = ?, nivel_vip = ? WHERE id = ?', [nuevo_qr, nuevo_nivel, cliente[0].id]);
        await connection.query('INSERT INTO historial_cashback (empresa_id, id_cliente, monto, tipo, descripcion) VALUES (?, ?, ?, "traspaso", ?)', [req.usuario.empresa_id, cliente[0].id, 0, `Traspaso a ${nuevo_nivel}`]);
        await connection.commit(); enviarCorreoVIP(cliente[0].email, cliente[0].nombre, nuevo_qr, nuevo_nivel, 0); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/vender', async (req, res) => {
    let { carrito, metodo_pago, codigo_creador, mp_intent_id, qr_vip, monto_cashback_usado } = req.body; 
    const { empresa_id, sucursal_id } = req.usuario;

    if (metodo_pago === 'Tarjeta MP') metodo_pago = 'Tarjeta';
    
    // (Verificamos que haya mp_intent_id si es Tarjeta MP u otro proveedor, la validación se hace en el enrutador multi-terminal)

    const connection = await pool.getConnection(); await connection.beginTransaction(); 
    try { 
        let resumen = ""; let total = 0; let piezas = 0; let tieneProductosDeLinea = false;
        
        for (let item of carrito) { 
            let precioFinal = item.en_rebaja ? item.precio_rebaja : item.precio_venta;
            if (!item.en_rebaja) tieneProductosDeLinea = true;
            
            const [pRows] = await connection.query('SELECT tallas FROM productos WHERE id = ? AND empresa_id = ?', [item.id, empresa_id]);
            let tallasAct = [];
            if (pRows.length > 0 && pRows[0].tallas) {
                try { tallasAct = typeof pRows[0].tallas === 'string' ? JSON.parse(pRows[0].tallas) : pRows[0].tallas; } catch(e){}
                let tIndex = tallasAct.findIndex(t => t.talla === item.talla || (t.nombre && t.nombre === item.talla));
                if (tIndex !== -1 && tallasAct[tIndex].cantidad !== undefined) tallasAct[tIndex].cantidad = Math.max(0, tallasAct[tIndex].cantidad - item.cantidad);
            }
            const [update] = await connection.query('UPDATE productos SET stock_bodega = stock_bodega - ?, tallas = ? WHERE id = ? AND empresa_id = ? AND stock_bodega >= ?', [item.cantidad, JSON.stringify(tallasAct), item.id, empresa_id, item.cantidad]);
            if(update.affectedRows === 0) throw new Error(`Stock insuficiente: ${item.sku}`);
            resumen += `${item.cantidad}x [SKU: ${item.sku}] ${item.nombre} (Talla: ${item.talla}) a $${precioFinal} c/u. `; 
            total += (parseFloat(precioFinal) * item.cantidad); piezas += item.cantidad; 
        }

        let totalPagar = total; let clienteVip = null; let saldoUsado = parseFloat(monto_cashback_usado) || 0;

        if (qr_vip) { const [cRows] = await connection.query('SELECT * FROM clientes WHERE qr_hash = ? AND empresa_id = ?', [qr_vip, empresa_id]); if(cRows.length > 0) clienteVip = cRows[0]; }

        if (clienteVip && saldoUsado > 0) {
            if (saldoUsado > clienteVip.saldo_cashback) throw new Error("Saldo insuficiente");
            if (saldoUsado > total) saldoUsado = total; 
            if (!tieneProductosDeLinea && saldoUsado > 0) throw new Error("No usar saldo en rebajas exclusivas.");
            totalPagar = total - saldoUsado; resumen += `| Pago VIP: -$${saldoUsado.toFixed(2)} `;
            await connection.query('UPDATE clientes SET saldo_cashback = saldo_cashback - ? WHERE id = ?', [saldoUsado, clienteVip.id]);
            await connection.query('INSERT INTO historial_cashback (empresa_id, id_cliente, monto, tipo, descripcion) VALUES (?, ?, ?, "canjeado", ?)', [empresa_id, clienteVip.id, saldoUsado, `Canje ticket: $${total}`]);
        }

        if (codigo_creador && codigo_creador.trim() !== "") resumen += `| Vendedor: ${codigo_creador.trim()}`;

        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, sucursal_id, tipo, descripcion, monto, cantidad, metodo_pago) VALUES (?, ?, "VENTA_POS", ?, ?, ?, ?)', [empresa_id, sucursal_id, resumen, totalPagar, piezas, metodo_pago || 'Efectivo']); 

        let alerta_traspaso = null;
        if (clienteVip && saldoUsado === 0) {
            const [confRows] = await connection.query("SELECT parametro, valor FROM configuracion_tienda WHERE empresa_id = ?", [empresa_id]);
            let conf = {}; confRows.forEach(c => conf[c.parametro] = parseFloat(c.valor));
            let isTarj = (metodo_pago === 'Tarjeta'); let pctActual = 0;
            if (clienteVip.nivel_vip === 'plata') pctActual = isTarj ? (conf['cashback_plata_tarjeta']||2) : (conf['cashback_plata_efectivo']||5);
            if (clienteVip.nivel_vip === 'oro') pctActual = isTarj ? (conf['cashback_oro_tarjeta']||5) : (conf['cashback_oro_efectivo']||10);
            if (clienteVip.nivel_vip === 'titanio') pctActual = isTarj ? (conf['cashback_titanio_tarjeta']||8) : (conf['cashback_titanio_efectivo']||15);

            const cashbackGanado = (totalPagar * (pctActual / 100)).toFixed(2); const nuevasCompras = clienteVip.compras_totales + 1;
            if (nuevasCompras === 10 && clienteVip.nivel_vip === 'plata') alerta_traspaso = 'oro'; else if (nuevasCompras === 15 && clienteVip.nivel_vip === 'oro') alerta_traspaso = 'titanio';

            await connection.query('UPDATE clientes SET saldo_cashback = saldo_cashback + ?, compras_totales = ? WHERE id = ?', [cashbackGanado, nuevasCompras, clienteVip.id]);
            await connection.query('INSERT INTO historial_cashback (empresa_id, id_cliente, monto, tipo, descripcion) VALUES (?, ?, ?, "acumulado", ?)', [empresa_id, clienteVip.id, cashbackGanado, `Acumuló ${pctActual}% en venta #${nuevasCompras}`]);
        }
        await connection.commit(); res.json({ exito: true, total: totalPagar, alerta_traspaso }); 
    } catch(e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/cambio', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const { entran, salen, motivo } = req.body; let resumenEntran = ""; let resumenSalen = "";
        for (let item of entran) {
            const [pRows] = await connection.query('SELECT tallas FROM productos WHERE id = ? AND empresa_id = ?', [item.id, req.usuario.empresa_id]);
            let tallasAct = [];
            if (pRows.length > 0 && pRows[0].tallas) { try { tallasAct = typeof pRows[0].tallas === 'string' ? JSON.parse(pRows[0].tallas) : pRows[0].tallas; } catch(e){} let tIndex = tallasAct.findIndex(t => t.talla === item.talla_seleccionada); if (tIndex !== -1) { tallasAct[tIndex].cantidad += 1; } else { tallasAct.push({talla: item.talla_seleccionada, cantidad: 1}); } }
            await connection.query('UPDATE productos SET stock_bodega = stock_bodega + 1, tallas = ? WHERE id = ? AND empresa_id = ?', [JSON.stringify(tallasAct), item.id, req.usuario.empresa_id]); resumenEntran += `[SKU: ${item.sku}] ${item.nombre} (Talla: ${item.talla_seleccionada}). `;
        }
        for (let item of salen) {
            const [pRows] = await connection.query('SELECT tallas FROM productos WHERE id = ? AND empresa_id = ?', [item.id, req.usuario.empresa_id]);
            let tallasAct = [];
            if (pRows.length > 0 && pRows[0].tallas) { try { tallasAct = typeof pRows[0].tallas === 'string' ? JSON.parse(pRows[0].tallas) : pRows[0].tallas; } catch(e){} let tIndex = tallasAct.findIndex(t => t.talla === item.talla_seleccionada); if (tIndex !== -1) { tallasAct[tIndex].cantidad = Math.max(0, tallasAct[tIndex].cantidad - 1); } }
            const [update] = await connection.query('UPDATE productos SET stock_bodega = stock_bodega - 1, tallas = ? WHERE id = ? AND empresa_id = ? AND stock_bodega >= 1', [JSON.stringify(tallasAct), item.id, req.usuario.empresa_id]);
            if(update.affectedRows === 0) throw new Error(`Stock insuficiente: ${item.sku}`); resumenSalen += `[SKU: ${item.sku}] ${item.nombre} (Talla: ${item.talla_seleccionada}). `;
        }
        const desc = `Entró: ${resumenEntran} | Salió: ${resumenSalen} | Motivo: ${motivo}`;
        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, sucursal_id, tipo, descripcion, monto, cantidad) VALUES (?, ?, "CAMBIO_FISICO", ?, 0, 0)', [req.usuario.empresa_id, req.usuario.sucursal_id, desc]);
        await connection.commit(); res.json({ exito: true });
    } catch(e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/pre-registro', upload.single('foto'), async (req, res) => {
    try { const fotoUrl = req.file ? `/uploads/${req.file.filename}` : null; const [result] = await pool.query(`INSERT INTO productos (empresa_id, sku, nombre, precio_venta, tallas, stock_bodega, estado_web, estado, url_foto_principal) VALUES (?, ?, ?, ?, ?, ?, 0, 'activo', ?)`, [req.usuario.empresa_id, req.body.sku, req.body.nombre_interno, req.body.precio, req.body.tallas, req.body.stock_total, fotoUrl]); res.json({ exito: true, id: result.insertId, foto_url: fotoUrl }); } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/api/pos/actualizar-foto/:id', upload.single('foto'), async (req, res) => {
    try { if (!req.file) return res.status(400).json({ exito: false, error: 'No se recibió imagen' }); const fotoUrl = `/uploads/${req.file.filename}`; await pool.query('UPDATE productos SET url_foto_principal = ? WHERE id = ? AND empresa_id = ?', [fotoUrl, req.params.id, req.usuario.empresa_id]); res.json({ exito: true, foto_url: fotoUrl }); } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/api/pos/corte-caja', async (req, res) => {
    try { const { cajero, ventas_efectivo, ventas_tarjeta, ventas_transferencia, gastos_totales, detalles } = req.body; const tot = (ventas_efectivo || 0) + (ventas_tarjeta || 0) + (ventas_transferencia || 0); await pool.query(`INSERT INTO historial_cortes (empresa_id, sucursal_id, cajero, ventas_totales, ventas_efectivo, ventas_tarjeta, ventas_transferencia, gastos_totales, detalles, fecha_corte) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, [req.usuario.empresa_id, req.usuario.sucursal_id, cajero, tot, ventas_efectivo, ventas_tarjeta, ventas_transferencia, gastos_totales, JSON.stringify(detalles || {})]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); }
});

// ==============================================================================
// 💳 ENRUTADOR MULTI-TERMINAL SAAS (Mercado Pago, Clip, Santander, Zettle)
// ==============================================================================

// 1. Enviar el cobro a la terminal seleccionada
app.post('/api/pos/terminal/cobrar', async (req, res) => {
    try {
        const { total, proveedor } = req.body; // proveedor puede ser: 'mercadopago', 'clip', 'santander'
        const { empresa_id } = req.usuario;

        const [empresa] = await pool.query('SELECT llaves_api FROM empresas WHERE id = ?', [empresa_id]);
        const llaves = empresa[0].llaves_api || {};
        
        const referencia_interna = `POS-${empresa_id}-${Date.now()}`;
        const montoEnCentavos = Math.round(total * 100);

        if (proveedor === 'mercadopago') {
            const deviceId = llaves.mp_device_id;
            const token = llaves.mp_access_token;
            if (!deviceId || !token) return res.status(400).json({ exito: false, error: 'Llaves Mercado Pago no configuradas.' });

            const urlMP = `https://api.mercadopago.com/point/integration-api/devices/${deviceId}/payment-intents`;
            const response = await fetch(urlMP, { 
                method: 'POST', 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ amount: montoEnCentavos, additional_info: { external_reference: referencia_interna, print_on_terminal: true } }) 
            });
            const data = await response.json(); 
            if (response.ok && data.id) return res.json({ exito: true, intent_id: data.id, proveedor: 'mercadopago' });
            else throw new Error('Terminal MP no responde.');

        } else if (proveedor === 'clip') {
            const token = llaves.clip_api_key;
            if (!token) return res.status(400).json({ exito: false, error: 'Llaves Clip no configuradas.' });
            
            // Ejemplo de llamada a la API de Clip (Push to Device)
            const urlClip = `https://api.payclip.com/payment/request`;
            const response = await fetch(urlClip, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: total, reference: referencia_interna, message: "Cobro SaaS" })
            });
            const data = await response.json();
            return res.json({ exito: true, intent_id: data.payment_request_id || referencia_interna, proveedor: 'clip' });

        } else if (proveedor === 'santander') {
            // Aquí se integra la lógica de API de Getnet / Santander
            const terminalId = llaves.santander_terminal_id;
            if (!terminalId) return res.status(400).json({ exito: false, error: 'Terminal Santander no configurada.' });
            return res.json({ exito: true, intent_id: referencia_interna, proveedor: 'santander' });
        } 
        
        else {
            return res.status(400).json({ exito: false, error: 'Proveedor de terminal no soportado.' });
        }
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

// 2. Verificar el estado del cobro (Polling)
app.get('/api/pos/terminal/estado/:proveedor/:intent_id', async (req, res) => {
    try {
        const { proveedor, intent_id } = req.params;
        const [empresa] = await pool.query('SELECT llaves_api FROM empresas WHERE id = ?', [req.usuario.empresa_id]);
        const llaves = empresa[0].llaves_api || {};

        if (proveedor === 'mercadopago') {
            const token = llaves.mp_access_token;
            const response = await fetch(`https://api.mercadopago.com/point/integration-api/payment-intents/${intent_id}`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await response.json(); 
            if (response.ok && data.state) { 
                let estadoPago = 'desconocido'; 
                if (data.state === 'FINISHED' && data.payment && data.payment.id) { 
                    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.payment.id}`, { headers: { 'Authorization': `Bearer ${token}` } }); 
                    const payData = await payRes.json(); estadoPago = payData.status || 'desconocido'; 
                } else if (data.state === 'CANCELED' || data.state === 'ERROR') estadoPago = 'rejected'; 
                return res.json({ exito: true, estado: data.state, estado_pago: estadoPago }); 
            }
        } else if (proveedor === 'clip') {
            // Lógica de verificación de estado en Clip API
            return res.json({ exito: true, estado: 'FINISHED', estado_pago: 'approved' }); // Simulación
        }

        res.status(400).json({ exito: false, error: 'Verificación no disponible.' });
    } catch (e) { res.status(500).json({ exito: false, error: 'Fallo al consultar a la terminal.' }); }
});

// 3. Webhook Dinámico que recibe confirmaciones de cualquier empresa
app.post('/api/pos/terminal/webhook/:proveedor', async (req, res) => {
    try {
        const { proveedor } = req.params;
        const evento = req.body; 
        res.status(200).send("OK"); // Responder siempre rápido al webhook

        const connection = await pool.getConnection();

        if (proveedor === 'mercadopago' && (evento.action === "payment.created" || evento.type === "payment")) {
            const pagoId = evento.data.id; 
            const [pedidos] = await connection.query("SELECT * FROM pedidos_web WHERE id_transaccion = ? OR id_transaccion = ?", [`MP-${pagoId}`, pagoId.toString()]);
            if (pedidos.length > 0) {
                const empresa_id = pedidos[0].empresa_id;
                const [emp] = await connection.query('SELECT llaves_api FROM empresas WHERE id = ?', [empresa_id]);
                const token = (emp[0].llaves_api || {}).mp_access_token;
                if(token){
                    const response = await fetch(`https://api.mercadopago.com/v1/payments/${pagoId}`, { headers: { 'Authorization': `Bearer ${token}` } });
                    const datosPago = await response.json();
                    if (datosPago.status === "approved") {
                        await connection.query("UPDATE pedidos_web SET estado = 'preparando_envio' WHERE id = ?", [pedidos[0].id]);
                        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, tipo, descripcion, monto, cantidad, metodo_pago) VALUES (?, "VENTA_WEB", ?, ?, 0, "Efectivo OXXO")', [empresa_id, `[PEDIDO WEB #${pedidos[0].id}] Pago Web Aprobado.`, datosPago.transaction_amount]);
                    }
                }
            }
        } else if (proveedor === 'clip' || proveedor === 'santander') {
            // Aquí se recibe la notificación de Clip o Santander Webhooks
        }
        
        connection.release();
    } catch (e) { console.error(`Error Webhook ${req.params.proveedor}:`, e); }
});

// ==============================================================================
// 3.5 MÓDULO DE APARTADOS
// ==============================================================================
app.get('/api/pos/apartados', async (req, res) => {
    try { const [apartados] = await pool.query("SELECT * FROM apartados WHERE estado = 'activo' AND empresa_id = ? AND sucursal_id = ? ORDER BY fecha_creacion DESC", [req.usuario.empresa_id, req.usuario.sucursal_id]); res.json({ exito: true, apartados }); } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.post('/api/pos/apartados/nuevo', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        let { cliente, carrito, enganche, total, metodo_pago } = req.body; let resumen = ""; let piezas = 0;
        for (let item of carrito) {
            const [pRows] = await connection.query('SELECT tallas FROM productos WHERE id = ? AND empresa_id = ?', [item.id, req.usuario.empresa_id]); let tallasAct = [];
            if (pRows.length > 0 && pRows[0].tallas) { try { tallasAct = typeof pRows[0].tallas === 'string' ? JSON.parse(pRows[0].tallas) : pRows[0].tallas; } catch(e){} let tIndex = tallasAct.findIndex(t => t.talla === item.talla); if (tIndex !== -1) { tallasAct[tIndex].cantidad = Math.max(0, tallasAct[tIndex].cantidad - item.cantidad); } }
            const [update] = await connection.query('UPDATE productos SET stock_bodega = stock_bodega - ?, tallas = ? WHERE id = ? AND empresa_id = ? AND stock_bodega >= ?', [item.cantidad, JSON.stringify(tallasAct), item.id, req.usuario.empresa_id, item.cantidad]);
            if(update.affectedRows === 0) throw new Error(`Stock insuficiente: ${item.sku}`);
            resumen += `${item.cantidad}x [SKU: ${item.sku}] ${item.nombre} (Talla: ${item.talla}). `; piezas += item.cantidad;
        }
        const resta = total - enganche;
        await connection.query('INSERT INTO apartados (empresa_id, sucursal_id, cliente, descripcion_prendas, total, enganche, resta, items, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "activo")', [req.usuario.empresa_id, req.usuario.sucursal_id, cliente, resumen, total, enganche, resta, JSON.stringify(carrito)]);
        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, sucursal_id, tipo, descripcion, monto, cantidad, metodo_pago) VALUES (?, ?, "ENGANCHE_APARTADO", ?, ?, ?, ?)', [req.usuario.empresa_id, req.usuario.sucursal_id, `Enganche: ${cliente} | ${resumen}`, enganche, piezas, metodo_pago || 'Efectivo']);
        await connection.commit(); res.json({ exito: true });
    } catch(e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/apartados/abonar/:id', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const [rows] = await connection.query("SELECT * FROM apartados WHERE id = ? AND estado = 'activo' AND empresa_id = ? AND sucursal_id = ?", [req.params.id, req.usuario.empresa_id, req.usuario.sucursal_id]); if (rows.length === 0) throw new Error("Apartado no encontrado");
        const apartado = rows[0]; const pago = parseFloat(req.body.pago) || 0.0; if(pago <= 0) throw new Error("Monto inválido");
        const nuevaResta = parseFloat(apartado.resta) - pago;
        await connection.query("UPDATE apartados SET resta = ? WHERE id = ?", [nuevaResta, apartado.id]);
        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, sucursal_id, tipo, descripcion, monto, metodo_pago) VALUES (?, ?, "ABONO_APARTADO", ?, ?, ?)', [req.usuario.empresa_id, req.usuario.sucursal_id, `Abono cuenta: ${apartado.cliente}`, pago, req.body.metodo_pago || 'Efectivo']);
        await connection.commit(); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/apartados/liquidar/:id', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const [rows] = await connection.query("SELECT * FROM apartados WHERE id = ? AND estado = 'activo' AND empresa_id = ? AND sucursal_id = ?", [req.params.id, req.usuario.empresa_id, req.usuario.sucursal_id]); if (rows.length === 0) throw new Error("Apartado no encontrado");
        const apartado = rows[0]; const pago = req.body.pago || apartado.resta; 
        await connection.query("UPDATE apartados SET estado = 'liquidado', resta = 0 WHERE id = ?", [apartado.id]);
        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, sucursal_id, tipo, descripcion, monto, metodo_pago) VALUES (?, ?, "LIQUIDACION_APARTADO", ?, ?, ?)', [req.usuario.empresa_id, req.usuario.sucursal_id, `Liquidación: ${apartado.cliente}`, pago, req.body.metodo_pago || 'Efectivo']);
        await connection.commit(); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

app.post('/api/pos/apartados/cancelar/:id', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const [rows] = await connection.query("SELECT * FROM apartados WHERE id = ? AND estado = 'activo' AND empresa_id = ? AND sucursal_id = ?", [req.params.id, req.usuario.empresa_id, req.usuario.sucursal_id]); if (rows.length === 0) throw new Error("Apartado no encontrado");
        const apartado = rows[0]; const items = typeof apartado.items === 'string' ? JSON.parse(apartado.items) : apartado.items;
        for (let item of items) {
            const [pRows] = await connection.query('SELECT tallas FROM productos WHERE id = ? AND empresa_id = ?', [item.id, req.usuario.empresa_id]); let tallasAct = [];
            if (pRows.length > 0 && pRows[0].tallas) { try { tallasAct = typeof pRows[0].tallas === 'string' ? JSON.parse(pRows[0].tallas) : pRows[0].tallas; } catch(e){} let tIndex = tallasAct.findIndex(t => t.talla === item.talla); if (tIndex !== -1) { tallasAct[tIndex].cantidad += item.cantidad; } else { tallasAct.push({talla: item.talla, cantidad: item.cantidad}); } }
            await connection.query('UPDATE productos SET stock_bodega = stock_bodega + ?, tallas = ? WHERE id = ? AND empresa_id = ?', [item.cantidad, JSON.stringify(tallasAct), item.id, req.usuario.empresa_id]);
        }
        await connection.query("UPDATE apartados SET estado = 'cancelado' WHERE id = ?", [apartado.id]);
        await connection.query('INSERT INTO bitacora_movimientos (empresa_id, sucursal_id, tipo, descripcion, monto) VALUES (?, ?, "CANCELACION_APARTADO", ?, 0)', [req.usuario.empresa_id, req.usuario.sucursal_id, `Cancelado: ${apartado.cliente}`]);
        await connection.commit(); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(400).json({ exito: false, error: e.message }); } finally { connection.release(); }
});

// ==============================================================================
// 4. APLICACIÓN OFICINA (RADAR, VENDEDORES, IA, ETC.)
// ==============================================================================
app.get('/api/oficina/configuracion', async (req, res) => {
    try { const [rows] = await pool.query('SELECT parametro, valor FROM configuracion_tienda WHERE empresa_id = ?', [req.usuario.empresa_id]); let config = {}; rows.forEach(r => config[r.parametro] = r.valor); res.json({ exito: true, config }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.put('/api/oficina/configuracion', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        const { bono_bienvenida, pl_efe, pl_tar, or_efe, or_tar, ti_efe, ti_tar } = req.body; const eID = req.usuario.empresa_id;
        const setConf = async (param, val) => await connection.query(`INSERT INTO configuracion_tienda (parametro, empresa_id, valor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = ?`, [param, eID, val, val]);
        await setConf('bono_bienvenida', bono_bienvenida); await setConf('cashback_plata_efectivo', pl_efe); await setConf('cashback_plata_tarjeta', pl_tar); await setConf('cashback_oro_efectivo', or_efe); await setConf('cashback_oro_tarjeta', or_tar); await setConf('cashback_titanio_efectivo', ti_efe); await setConf('cashback_titanio_tarjeta', ti_tar);
        await connection.commit(); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(500).json({ exito: false }); } finally { connection.release(); }
});

app.get('/api/oficina/clientes', async (req, res) => { try { const [clientes] = await pool.query('SELECT * FROM clientes WHERE empresa_id = ? ORDER BY id DESC', [req.usuario.empresa_id]); res.json({ exito: true, clientes }); } catch (e) { res.status(500).json({ exito: false }); } });

app.delete('/api/oficina/clientes/:id', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try { await connection.query('DELETE FROM historial_cashback WHERE id_cliente = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]); await connection.query('DELETE FROM clientes WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]); await connection.commit(); res.json({ exito: true }); } catch (e) { await connection.rollback(); res.status(500).json({ exito: false }); } finally { connection.release(); }
});

app.post('/api/oficina/verificar-admin', async (req, res) => { try { const [rows] = await pool.query('SELECT id FROM staff WHERE password=? AND rol="admin_oficina" AND empresa_id=?', [req.body.password, req.usuario.empresa_id]); if (rows.length > 0) res.json({ exito: true }); else res.status(401).json({ exito: false }); } catch (e) { res.status(500).json({ exito: false }); } });

app.put('/api/oficina/cambiar-claves', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try {
        if (req.body.clavePos && req.body.clavePos.trim() !== '') await connection.query('UPDATE staff SET password = ? WHERE rol = "vendedor_pos" AND empresa_id = ?', [req.body.clavePos.trim(), req.usuario.empresa_id]);
        if (req.body.claveOficina && req.body.claveOficina.trim() !== '') await connection.query('UPDATE staff SET password = ? WHERE rol = "admin_oficina" AND empresa_id = ?', [req.body.claveOficina.trim(), req.usuario.empresa_id]);
        await connection.commit(); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(500).json({ exito: false }); } finally { connection.release(); }
});

app.get('/api/oficina/ventas-en-vivo', async (req, res) => {
    try {
        const { fechaInicio, fechaFin } = req.query; let whereClause = "DATE(b.fecha) = CURDATE()"; const params = [req.usuario.empresa_id];
        if (fechaInicio && fechaFin) { whereClause = "DATE(b.fecha) BETWEEN ? AND ?"; params.push(fechaInicio, fechaFin); }
        const query = `SELECT b.id, b.tipo, b.descripcion, b.monto, b.cantidad, b.metodo_pago, DATE_FORMAT(b.fecha, '%d/%m/%Y') AS fecha_fmt, DATE_FORMAT(b.fecha, '%h:%i %p') AS hora_fmt, COALESCE(s.nombre, 'Web/General') AS sucursal_nombre FROM bitacora_movimientos b LEFT JOIN sucursales s ON b.sucursal_id = s.id WHERE b.empresa_id = ? AND ${whereClause} AND b.tipo IN ('VENTA_POS', 'ENGANCHE_APARTADO', 'ABONO_APARTADO', 'LIQUIDACION_APARTADO', 'CAMBIO_FISICO', 'PAGO_COMISIONES', 'VENTA_WEB') ORDER BY b.fecha DESC`;
        const [ventasRaw] = await pool.query(query, params);
        
        let ventas = [];
        for (let v of ventasRaw) {
            if (v.metodo_pago && v.metodo_pago.startsWith('MIXTO')) {
                const match = v.metodo_pago.match(/Efectivo:\s*\$([\d\.]+),\s*Transf:\s*\$([\d\.]+)/);
                if (match) { const montoEf = parseFloat(match[1]); const montoTr = parseFloat(match[2]); if (montoEf > 0) ventas.push({ ...v, monto: montoEf, metodo_pago: 'Efectivo', descripcion: v.descripcion + ' [Abono Efectivo]' }); if (montoTr > 0) ventas.push({ ...v, monto: montoTr, cantidad: 0, metodo_pago: 'Transferencia', descripcion: v.descripcion.replace(/\d+x\s*\[SKU:.*?\]/g, 'Pago Mixto') + ' [Complemento Transf]' }); } else ventas.push(v);
            } else ventas.push(v);
        }
        res.json({ exito: true, ventas });
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

app.get('/api/oficina/cortes-caja', async (req, res) => { try { const [cortes] = await pool.query(`SELECT h.id, h.cajero, h.ventas_totales, h.ventas_efectivo, h.ventas_tarjeta, h.ventas_transferencia, h.gastos_totales, h.detalles, DATE_FORMAT(h.fecha_corte, '%d/%m/%Y - %h:%i %p') AS fecha_formateada, COALESCE(s.nombre, 'Sin Sucursal') AS sucursal_nombre FROM historial_cortes h LEFT JOIN sucursales s ON h.sucursal_id = s.id WHERE h.empresa_id = ? ORDER BY h.fecha_corte DESC`, [req.usuario.empresa_id]); res.json({ exito: true, cortes }); } catch (e) { res.status(500).json({ exito: false }); } });

app.delete('/api/oficina/productos/:id', async (req, res) => { try { await pool.query("UPDATE productos SET estado = 'eliminado', estado_web = 0 WHERE id = ? AND empresa_id = ?", [req.params.id, req.usuario.empresa_id]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); } });
app.put('/api/oficina/productos/:id/oferta', async (req, res) => { try { await pool.query("UPDATE productos SET en_rebaja = ?, precio_rebaja = ? WHERE id = ? AND empresa_id = ?", [req.body.en_rebaja, req.body.precio_rebaja, req.params.id, req.usuario.empresa_id]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); } });
app.put('/api/oficina/productos/:id/resurtir', async (req, res) => { try { await pool.query("UPDATE productos SET tallas = ?, stock_bodega = ? WHERE id = ? AND empresa_id = ?", [JSON.stringify(req.body.tallas), req.body.stock_bodega, req.params.id, req.usuario.empresa_id]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); } });

app.post('/api/oficina/carga-masiva', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try { for (let p of req.body.productos) { await connection.query(`INSERT INTO productos (empresa_id, sku, nombre, precio_venta, tallas, stock_bodega, estado_web, estado) VALUES (?, ?, ?, ?, ?, ?, 0, 'activo')`, [req.usuario.empresa_id, p.sku, p.nombre_interno, p.precio, JSON.stringify(p.tallas), p.stock_total]); } await connection.commit(); res.json({ exito: true }); } catch (e) { await connection.rollback(); res.status(500).json({ exito: false }); } finally { connection.release(); }
});

app.get('/api/oficina/gastos-fijos', async (req, res) => { try { const [gastos] = await pool.query(`SELECT * FROM gastos_fijos WHERE empresa_id = ? ORDER BY id DESC`, [req.usuario.empresa_id]); res.json({ exito: true, gastos }); } catch (e) { res.status(500).json({ exito: false }); } });
app.post('/api/oficina/gastos-fijos', async (req, res) => { try { await pool.query(`INSERT INTO gastos_fijos (empresa_id, sucursal_id, concepto, monto) VALUES (?, ?, ?, ?)`, [req.usuario.empresa_id, req.usuario.sucursal_id, req.body.concepto, req.body.monto]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); } });
app.delete('/api/oficina/gastos-fijos/:id', async (req, res) => { try { await pool.query(`DELETE FROM gastos_fijos WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); } });

app.delete('/api/oficina/vendedores/:id', async (req, res) => { try { await pool.query(`DELETE FROM staff WHERE id = ? AND rol = 'vendedor_comisionista' AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); } });
app.post('/api/oficina/vendedores', async (req, res) => { try { const [result] = await pool.query(`INSERT INTO staff (empresa_id, nombre, usuario, password, rol, comision, descuento_cliente) VALUES (?, ?, ?, 'temporal123', 'vendedor_comisionista', ?, ?)`, [req.usuario.empresa_id, req.body.nombre, req.body.codigo_creador, req.body.comision_porcentaje, req.body.descuento_cliente]); res.json({ exito: true, id_vendedor: result.insertId }); } catch (e) { res.status(500).json({ exito: false }); } });

app.get('/api/oficina/vendedores', async (req, res) => {
    try { const [vendedores] = await pool.query(`SELECT id, nombre, usuario AS codigo_creador, comision, descuento_cliente, (SELECT COALESCE(SUM(monto), 0) FROM bitacora_movimientos WHERE descripcion LIKE CONCAT('%| Vendedor: ', staff.usuario, '%') AND empresa_id = ?) AS ventas_totales, (SELECT COALESCE(SUM(cantidad), 0) FROM bitacora_movimientos WHERE descripcion LIKE CONCAT('%| Vendedor: ', staff.usuario, '%') AND empresa_id = ?) AS piezas_vendidas FROM staff WHERE rol = 'vendedor_comisionista' AND empresa_id = ?`, [req.usuario.empresa_id, req.usuario.empresa_id, req.usuario.empresa_id]); res.json({ exito: true, vendedores }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.post('/api/oficina/vendedores/pagar', async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction();
    try { await connection.query('INSERT INTO bitacora_movimientos (empresa_id, tipo, descripcion, monto, cantidad, metodo_pago) VALUES (?, "PAGO_COMISIONES", ?, ?, ?, "Efectivo")', [req.usuario.empresa_id, `Liquidación de comisiones | Vendedor: ${req.body.codigo_creador}`, -req.body.ventas_totales, -req.body.piezas]); await connection.commit(); res.json({ exito: true }); } catch (e) { await connection.rollback(); res.status(500).json({ exito: false }); } finally { connection.release(); }
});

app.get('/api/cupones/validar/:codigo', async (req, res) => { try { const [rows] = await pool.query(`SELECT descuento_cliente FROM staff WHERE usuario = ? AND rol = 'vendedor_comisionista' AND empresa_id = ?`, [req.params.codigo.toUpperCase(), req.usuario.empresa_id]); if (rows.length > 0) res.json({ valido: true, descuento: rows[0].descuento_cliente, tipo: 'fijo' }); else res.json({ valido: false }); } catch (e) { res.status(500).json({ valido: false }); } });

app.put('/api/oficina/publicar-web/:id', upload.array('fotos', 5), async (req, res) => {
    const connection = await pool.getConnection(); await connection.beginTransaction(); 
    try {
        const { nombre_web, categoria, tipo, descripcion, corte, estado_web } = req.body;
        if (estado_web === '0') { await connection.query('UPDATE productos SET estado_web = 0 WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]); await connection.commit(); return res.json({ exito: true }); }
        let idCorte = null; if (corte) { const [rowsCorte] = await connection.query('SELECT id FROM cortes WHERE nombre_corte = ?', [corte]); if (rowsCorte.length > 0) idCorte = rowsCorte[0].id; else { const [resCorte] = await connection.query('INSERT INTO cortes (nombre_corte) VALUES (?)', [corte]); idCorte = resCorte.insertId; } }
        const fotosRutas = req.files ? req.files.map(f => `${DOMINIO_SAAS}/uploads/${f.filename}`) : []; const fotoPr = fotosRutas.length > 0 ? fotosRutas[0] : null; const fotosEx = fotosRutas.length > 1 ? JSON.stringify(fotosRutas.slice(1)) : null;
        await connection.query(`UPDATE productos SET nombre_web = COALESCE(?, nombre_web), categoria = COALESCE(?, categoria), tipo = COALESCE(?, tipo), descripcion = COALESCE(?, descripcion), id_corte = COALESCE(?, id_corte), url_foto_principal = COALESCE(?, url_foto_principal), urls_fotos_extra = COALESCE(?, urls_fotos_extra), estado_web = 1 WHERE id = ? AND empresa_id = ?`, [nombre_web, categoria, tipo, descripcion, idCorte, fotoPr, fotosEx, req.params.id, req.usuario.empresa_id]);
        await connection.commit(); res.json({ exito: true });
    } catch (e) { await connection.rollback(); res.status(500).json({ exito: false }); } finally { connection.release(); }
});

app.get('/api/oficina/vip/sorteo/:nivel', async (req, res) => {
    try { let query = "SELECT nombre, nivel_vip, email FROM clientes WHERE saldo_cashback >= 0 AND empresa_id = ?"; let params = [req.usuario.empresa_id]; if (req.params.nivel !== 'todos') { query += " AND nivel_vip = ?"; params.push(req.params.nivel); } const [clientes] = await pool.query(query, params); if(clientes.length === 0) return res.status(404).json({ exito: false, error: 'No hay clientes.' }); res.json({ exito: true, ganador: clientes[Math.floor(Math.random() * clientes.length)], participantes: clientes.length }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.get('/api/oficina/nfc/verificar/:chip_hash', async (req, res) => { try { const [chip] = await pool.query(`SELECT n.estado, p.nombre, p.url_foto_principal, p.categoria FROM chips_nfc n JOIN productos p ON n.id_producto = p.id WHERE n.chip_hash = ? AND p.empresa_id = ?`, [req.params.chip_hash, req.usuario.empresa_id]); if (chip.length === 0) return res.status(404).json({ autentico: false }); res.json({ autentico: true, prenda: chip[0] }); } catch (e) { res.status(500).json({ error: "Error NFC" }); } });

// ==============================================================================
// 🤖 INTELIGENCIA ARTIFICIAL DINÁMICA (BYOK)
// ==============================================================================
app.post('/api/oficina/ia/escanear-recibo', upload.single('foto_recibo'), async (req, res) => {
    try { 
        if (!req.file) return res.status(400).json({ error: 'Falta imagen' }); 
        
        const [emp] = await pool.query('SELECT llaves_api FROM empresas WHERE id = ?', [req.usuario.empresa_id]);
        const keyGemini = (emp[0].llaves_api || {}).gemini_api_key;
        if (!keyGemini) return res.status(400).json({ error: 'Configura tu API Key de Gemini en el Panel de Llaves.' });

        const genAICliente = new GoogleGenerativeAI(keyGemini);
        const resIA = await genAICliente.getGenerativeModel({ model: "gemini-2.5-flash" }).generateContent([`Extrae JSON estricto: {"fecha":"DD/MM/AAAA","tienda_proveedor":"Nombre","total":0.0,"conceptos":[{"cantidad":0,"descripcion":"Detalle"}]}`, prepImg(req.file.path, req.file.mimetype)]); 
        res.json({ exito: true, datos: JSON.parse(resIA.response.text().replace(/\x60\x60\x60json/gi, '').replace(/\x60\x60\x60/g, '').trim()) }); 
    } catch (e) { res.status(500).json({ error: 'Error IA. Verifica que la llave sea válida.' }); }
});

app.post('/api/oficina/ia/copiloto', async (req, res) => {
    try { 
        const [emp] = await pool.query('SELECT llaves_api FROM empresas WHERE id = ?', [req.usuario.empresa_id]);
        const keyGemini = (emp[0].llaves_api || {}).gemini_api_key;
        if (!keyGemini) return res.json({ exito: false, respuesta: "El cerebro IA está desconectado. Ve a configuración y agrega tu API Key de Google Gemini." });

        const genAICliente = new GoogleGenerativeAI(keyGemini);
        const result = await genAICliente.getGenerativeModel({ model: "gemini-2.5-flash" }).generateContent(`Eres la IA Ejecutiva de un SaaS. Responde profesional (max 3 párrafos): ${req.body.pregunta}`); 
        res.json({ exito: true, respuesta: result.response.text() }); 
    } catch (e) { res.status(500).json({ exito: false, respuesta: "Error al contactar a la IA. Verifica tu llave API." }); }
});


// ==============================================================================
// 5. GESTIÓN DEL ESCAPARATE WEB (BANNERS Y HEROS - AISLADO POR EMPRESA)
// ==============================================================================
const getStorefrontFile = (empresa_id, isDraft) => path.join(process.cwd(), `storefront_${isDraft ? 'draft' : 'live'}_${empresa_id}.json`);
const leerJsonSeguro = (ruta) => { try { const cont = fs.readFileSync(ruta, 'utf8'); return cont.trim() === '' ? {} : JSON.parse(cont); } catch (e) { return {}; } };

app.get('/api/web/storefront', (req, res) => {
    try {
        const empresa_id = req.query.empresa_id || 1; 
        const isPreview = req.query.preview === 'true';
        const file = getStorefrontFile(empresa_id, isPreview);
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
        res.json({ exito: true, banners: leerJsonSeguro(file), modo: isPreview ? 'preview' : 'live' });
    } catch (e) { res.status(500).json({ exito: false, error: 'Error web' }); }
});

app.post('/api/oficina/storefront/draft', upload.single('imagen'), (req, res) => {
    try {
        const { seccion, dispositivo } = req.body; const file = getStorefrontFile(req.usuario.empresa_id, true);
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
        let draftData = leerJsonSeguro(file); if (!draftData[seccion]) draftData[seccion] = {};
        if (req.file) draftData[seccion][dispositivo] = `${DOMINIO_SAAS}/uploads/${req.file.filename}`; else if (req.body.url) draftData[seccion][dispositivo] = req.body.url;
        fs.writeFileSync(file, JSON.stringify(draftData, null, 2)); res.json({ exito: true, mensaje: "Borrador actualizado" });
    } catch (e) { res.status(500).json({ exito: false }); }
});

app.post('/api/oficina/upload-directo', upload.single('imagen'), (req, res) => {
    try { if (!req.file) return res.status(400).json({ exito: false, error: 'No imagen' }); res.json({ exito: true, url: `${DOMINIO_SAAS}/uploads/${req.file.filename}` }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.post('/api/oficina/storefront/guardar-seccion', (req, res) => {
    try { const file = getStorefrontFile(req.usuario.empresa_id, true); if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({})); let draftData = leerJsonSeguro(file); draftData[req.body.seccion] = req.body.datos; fs.writeFileSync(file, JSON.stringify(draftData, null, 2)); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); }
});

app.post('/api/oficina/storefront/publicar', (req, res) => {
    try { const draftFile = getStorefrontFile(req.usuario.empresa_id, true); const liveFile = getStorefrontFile(req.usuario.empresa_id, false); if (!fs.existsSync(draftFile)) fs.writeFileSync(draftFile, JSON.stringify({})); fs.writeFileSync(liveFile, JSON.stringify(leerJsonSeguro(draftFile), null, 2)); res.json({ exito: true }); } catch (e) { res.status(500).json({ exito: false }); }
});

// 🚀 ARRANQUE DEL SERVIDOR
app.listen(process.env.PORT || 3000, () => console.log(`🚀 API SaaS Multi-Tenant corriendo en puerto ${process.env.PORT || 3000} | Dominio configurado: ${DOMINIO_SAAS}`));