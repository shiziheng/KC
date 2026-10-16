'use strict';

const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'plus_papay';
const BUSINESS_DB_NAME = process.env.BUSINESS_DB_NAME || 'kc_business';

const EXPECTED_MIGRATIONS = new Map([
    ['0001_business_core.up.sql', '7eb0f2ef2acb9ba6b3249a294ac3bb16ca1ead2d680f87bd66066c0cb5764ffc'],
    ['0002_operations_enhancements.up.sql', '7481b95086b8a35e90c60f9157f72683ae28662b1e362c889c8507258c0124f5']
]);

let pool;
let schemaCheck;

function getBusinessPool() {
    if (BUSINESS_DB_NAME === DB_NAME) {
        const error = new Error('业务数据库必须与 KC 数据库隔离');
        error.code = 'BUSINESS_DATABASE_NOT_ISOLATED';
        throw error;
    }
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || '127.0.0.1',
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: BUSINESS_DB_NAME,
            charset: 'utf8mb4',
            waitForConnections: true,
            connectionLimit: Math.max(2, Math.min(Number(process.env.BUSINESS_DB_POOL_LIMIT) || 8, 16)),
            queueLimit: 0,
            multipleStatements: false,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
            decimalNumbers: false
        });
    }
    return pool;
}

async function assertSchemaReady() {
    if (!schemaCheck) {
        schemaCheck = (async () => {
            const [rows] = await getBusinessPool().query(
                `SELECT migration_name, checksum
                   FROM business_schema_migrations
                  WHERE migration_name IN (?, ?)` ,
                [...EXPECTED_MIGRATIONS.keys()]
            );
            const found = new Map(rows.map((row) => [row.migration_name, String(row.checksum).toLowerCase()]));
            for (const [name, expectedChecksum] of EXPECTED_MIGRATIONS) {
                if (found.get(name) !== expectedChecksum) {
                    const error = new Error('业务库尚未应用匹配的基础结构');
                    error.code = 'BUSINESS_SCHEMA_NOT_READY';
                    throw error;
                }
            }
            return true;
        })().catch((error) => {
            schemaCheck = null;
            throw error;
        });
    }
    return schemaCheck;
}

async function withBusinessTransaction(callback) {
    const connection = await getBusinessPool().getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try { await connection.rollback(); } catch (_) { /* preserve original error */ }
        throw error;
    } finally {
        connection.release();
    }
}

function businessDbInfo() {
    return { database: BUSINESS_DB_NAME };
}

module.exports = { getBusinessPool, assertSchemaReady, withBusinessTransaction, businessDbInfo };
