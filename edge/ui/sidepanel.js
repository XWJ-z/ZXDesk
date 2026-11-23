/**
 * sidepanel.js —— 侧边栏壳（只设置宿主并挂载 app 视图，内容唯一出处是 `ui/app.js`）。
 * @author zx
 * @since
 */
import { mountApp } from './app.js';

mountApp(document.getElementById('app'), 'sidepanel');
