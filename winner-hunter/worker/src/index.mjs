// Cloudflare Worker entry: the board page (board.html, bundled as text), its API (app.mjs) and the ad viewer's
// browser (Browser Run via @cloudflare/puppeteer, binding BROWSER).
import puppeteer from '@cloudflare/puppeteer';
import html from './board.html';
import { handle } from './app.mjs';

const launch = (binding) => puppeteer.launch(binding);

export default {
  fetch(request, env) {
    return handle(request, env, { html, launch });
  },
};
