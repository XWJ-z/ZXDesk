/**
 * 0.1.4 sidepanel 壳 —— 只做一件事：挂 app 视图（内容唯一出处 ui/app.js）。
 */
import { mountApp } from './app.js';

mountApp(document.getElementById('app'), 'sidepanel');
