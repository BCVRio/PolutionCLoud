export interface City { name: string; slug: string; lat: number; lon: number; }

export interface CityState {
  city: string; slug: string; lat: number; lon: number;
  updated: string | null; source: 'live' | 'cached' | 'simulated' | 'replay';
  no2: number; pm25: number; pm10: number; o3: number;
  no2_n: number; pm25_n: number; pm10_n: number; o3_n: number; max_n: number;
  wind_speed: number; wind_dir: number; lid_m: number; lid_approx: boolean;
  rain: number; solar: number; humidity: number; european_aqi: number;
}

export interface SoundControls {
  no2_level: number; no2_density: number; pm25_bed: number; pm10_rate: number; o3_bright: number;
  wind_angle: number; wind_rate: number; lid_size: number; rain_clear: number;
}

export interface Frame {
  type: 'frame'; t: number; mode: 'live' | 'replay' | 'simulated'; hasData: boolean;
  source: string; dataHour: string | null; preset: string; manual: Record<string, number>;
  replay: { speed: number; playing: boolean; time: number; start: number; end: number };
  active: string; selection: string; cycleRemaining: number; autoCycle: boolean;
  cities: CityState[]; sound: SoundControls;
  status: { lastSuccess: string | null; lastError: string | null; lastAttempt: string | null; attempts: number; failures: number; cachedFromDisk: boolean; osc: { enabled: boolean; host: string; port: number; sent: number; lastError: string | null } };
}

export interface Hello {
  type: 'hello'; cities: City[]; mapping: any; presets: Record<string, any>;
  app: { frameRateHz: number; osc: any; pollMinutes: number }; credits: string;
}
