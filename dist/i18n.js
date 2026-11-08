"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.localized = exports.tr = void 0;
const tr = (spanish, english) => english;
exports.tr = tr;
const localized = (locale, spanish, english) => locale === 'es' ? spanish : english;
exports.localized = localized;
