/** Подключается первым в main.tsx: в веб-версии window.zvon должен появиться до загрузки остальных модулей. */
import { IS_WEB } from '../edition'
import { installWebApi } from './api'

if (IS_WEB) installWebApi()
