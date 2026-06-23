/**
 * @module lib/bigquery
 * BigQuery client and query helper.
 */
const { BigQuery } = require('@google-cloud/bigquery');
const { PROJECT_ID } = require('./config');

const bq = new BigQuery({ projectId: PROJECT_ID });

async function runQuery(query, params, types) {
  const options = { query };
  if (params) options.params = params;
  if (types) options.types = types;
  const [rows] = await bq.query(options);
  return rows;
}

module.exports = { bq, runQuery };
