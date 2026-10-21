'use strict';
// Entrada serverless (Vercel): exporta o app Express sem listen.
// Localmente quem escuta é o server.js (npm start).
module.exports = require('../server');
