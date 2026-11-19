'use strict';
const { MagnetSource } = require('./magnet');
const adapters = { magnet: MagnetSource };

const DEFAULT_SOURCES = { magnet: { type: 'magnet', label: 'Magnetz', baseUrl: 'https://magnetz.eu', searchPath: '/api/magnets/search', queryParam: 'query' } };

function createSources(config = DEFAULT_SOURCES) {
    return Object.entries(config).map(([id, value]) => {
        const Type = adapters[value.type || id];
        if (!Type) return null;
        return { id, label: value.label || id, adapter: new Type(value) };
    }).filter(Boolean);
}

module.exports = { createSources, adapters, DEFAULT_SOURCES };
