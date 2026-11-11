import './style.css';
import { StateClient } from './net/StateClient';

// One page per output. The service serves index.html for every path.
const route = location.pathname.replace(/\/+$/, '') || '/';
const app = document.getElementById('app')!;
const client = new StateClient();

async function boot() {
  switch (route) {
    case '/floor': return (await import('./europe/EuropeView')).mountEurope(app, client);
    case '/city': return (await import('./city/CityView')).mountCity(app, client, 'all');
    case '/scrim-no2': return (await import('./city/CityView')).mountCity(app, client, 'no2');
    case '/scrim-pm': return (await import('./city/CityView')).mountCity(app, client, 'pm');
    case '/scrim-o3': return (await import('./city/CityView')).mountCity(app, client, 'o3');
    case '/sound': return (await import('./sound/SoundPage')).mountSound(app, client);
    case '/control': return (await import('./control/ControlPage')).mountControl(app, client);
    default: return (await import('./pages/Home')).mountHome(app, client);
  }
}
boot();
