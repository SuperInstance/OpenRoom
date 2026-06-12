import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLifecycle } from '@gui/vibe-container';
import { reportLifecycle, useAgentActionListener, type CharacterAppAction } from '@/lib';
import './i18n';
import styles from './index.module.scss';

// ============ Constants ============
const APP_ID = 15;
const DEFAULT_UNITS = 'metric';

// ============ Types ============
export type WeatherAction = { type: 'GET_WEATHER'; city?: string };

interface WeatherData {
  city: string;
  country: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  pressure: number;
  visibility: number;
  description: string;
  icon: string;
  sunrise: number;
  sunset: number;
  dt: number;
}

interface ForecastDay {
  day: string;
  tempHigh: number;
  tempLow: number;
  icon: string;
  description: string;
}

// ============ Helpers ============
function getOpenWeatherApiKey(): string {
  return import.meta.env.VITE_OPENWEATHER_API_KEY || '';
}

function weatherIconUrl(iconCode: string): string {
  return `https://openweathermap.org/img/wn/${iconCode}@2x.png`;
}

function unixToTime(unix: number): string {
  const date = new Date(unix * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function unixToDay(unix: number): string {
  const date = new Date(unix * 1000);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';

  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function groupForecastByDay(list: Array<{ dt: number; main: { temp_max: number; temp_min: number }; weather: Array<{ icon: string; description: string }> }>): ForecastDay[] {
  const days: Record<string, { highs: number[]; lows: number[]; icons: string[]; descriptions: string[] }> = {};

  for (const item of list) {
    const dayKey = new Date(item.dt * 1000).toDateString();
    if (!days[dayKey]) {
      days[dayKey] = { highs: [], lows: [], icons: [], descriptions: [] };
    }
    days[dayKey].highs.push(item.main.temp_max);
    days[dayKey].lows.push(item.main.temp_min);
    days[dayKey].icons.push(item.weather[0]?.icon || '01d');
    days[dayKey].descriptions.push(item.weather[0]?.description || '');
  }

  return Object.entries(days).slice(0, 5).map(([dayKey, data]) => {
    const midIndex = Math.floor(data.icons.length / 2);
    return {
      day: unixToDay(new Date(dayKey).getTime() / 1000),
      tempHigh: Math.round(Math.max(...data.highs)),
      tempLow: Math.round(Math.min(...data.lows)),
      icon: data.icons[midIndex] || data.icons[0],
      description: data.descriptions[midIndex] || data.descriptions[0],
    };
  });
}

// ============ Component ============
const WeatherApp: React.FC = () => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [forecast, setForecast] = useState<ForecastDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentCities, setRecentCities] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('weather_recent_cities');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Report lifecycle on mount
  useEffect(() => {
    reportLifecycle(AppLifecycle.LOADED);
    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
    };
  }, []);

  /**
   * Fetch current weather + 5-day forecast for a city
   */
  const fetchWeather = useCallback(async (city: string) => {
    const apiKey = getOpenWeatherApiKey();
    if (!apiKey) {
      setError(t('apiKeyMissing'));
      return;
    }

    setLoading(true);
    setError(null);
    setSearchQuery('');

    try {
      // Current weather
      const currentRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=${DEFAULT_UNITS}`
      );
      if (!currentRes.ok) {
        if (currentRes.status === 404) {
          throw new Error(t('noResults'));
        }
        throw new Error(t('error'));
      }
      const currentData = await currentRes.json();

      // 5-day forecast
      const forecastRes = await fetch(
        `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=${DEFAULT_UNITS}`
      );
      let forecastData: ForecastDay[] = [];
      if (forecastRes.ok) {
        const forecastJson = await forecastRes.json();
        forecastData = groupForecastByDay(forecastJson.list);
      }

      // Save to recent cities
      setRecentCities((prev) => {
        const updated = [city, ...prev.filter((c) => c.toLowerCase() !== city.toLowerCase())].slice(0, 5);
        localStorage.setItem('weather_recent_cities', JSON.stringify(updated));
        return updated;
      });

      setWeather({
        city: currentData.name,
        country: currentData.sys.country,
        temperature: Math.round(currentData.main.temp),
        feelsLike: Math.round(currentData.main.feels_like),
        humidity: currentData.main.humidity,
        windSpeed: Math.round(currentData.wind.speed * 3.6), // m/s to km/h
        pressure: currentData.main.pressure,
        visibility: Math.round(currentData.visibility / 1000), // m to km
        description: currentData.weather[0]?.description || '',
        icon: currentData.weather[0]?.icon || '01d',
        sunrise: currentData.sys.sunrise,
        sunset: currentData.sys.sunset,
        dt: currentData.dt,
      });
      setForecast(forecastData);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Load default city on first mount
  useEffect(() => {
    if (!weather && !loading && !error) {
      const defaultCity = t('defaultCity');
      // Only fetch if we have an API key
      if (getOpenWeatherApiKey()) {
        fetchWeather(defaultCity);
      }
    }
  }, [t, weather, loading, error, fetchWeather]);

  // Listen for agent-initiated actions
  useAgentActionListener(APP_ID, (action: CharacterAppAction) => {
    if (action.action_type === 'GET_WEATHER' && action.params?.city) {
      fetchWeather(action.params.city);
    }
  });

  // Search submit handler
  const handleSearch = useCallback(() => {
    const query = searchQuery.trim();
    if (query) {
      fetchWeather(query);
    }
  }, [searchQuery, fetchWeather]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSearch();
      }
    },
    [handleSearch]
  );

  const handleRecentCity = useCallback(
    (city: string) => {
      fetchWeather(city);
    },
    [fetchWeather]
  );

  // ============ Render ============
  const apiKey = getOpenWeatherApiKey();

  if (!apiKey) {
    return (
      <div className={styles.weatherApp}>
        <div className={styles.apiKeyNotice}>
          <div className={styles.noticeIcon}>🌤️</div>
          <p>{t('apiKeyMissing')}</p>
          <code>VITE_OPENWEATHER_API_KEY</code>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.weatherApp}>
      {/* Search Bar */}
      <div className={styles.searchBar}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('searchPlaceholder')}
        />
        <button onClick={handleSearch} disabled={loading}>
          {t('search')}
        </button>
      </div>

      {/* Recent Searches */}
      {recentCities.length > 0 && (
        <div className={styles.recentSearches}>
          <span>{t('recentSearches')}:</span>
          {recentCities.map((city) => (
            <button key={city} onClick={() => handleRecentCity(city)}>
              {city}
            </button>
          ))}
        </div>
      )}

      {/* Main Content */}
      <div className={styles.content}>
        {loading && (
          <div className={styles.statusMessage}>{t('loading')}</div>
        )}

        {error && !loading && (
          <div className={styles.statusMessage}>{error}</div>
        )}

        {weather && !loading && !error && (
          <>
            {/* Current Weather */}
            <div className={styles.currentWeather}>
              <div className={styles.cityName}>
                {weather.city}, {weather.country}
              </div>
              <div className={styles.dateTime}>
                {new Date(weather.dt * 1000).toLocaleDateString([], {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </div>
              <img
                className={styles.weatherIcon}
                src={weatherIconUrl(weather.icon)}
                alt={weather.description}
              />
              <div className={styles.temperature}>
                {weather.temperature}{t('celsius')}
              </div>
              <div className={styles.description}>{weather.description}</div>

              <div className={styles.details}>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>{t('feelsLike')}</span>
                  <span className={styles.detailValue}>{weather.feelsLike}{t('celsius')}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>{t('humidity')}</span>
                  <span className={styles.detailValue}>{weather.humidity}{t('percent')}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>{t('windSpeed')}</span>
                  <span className={styles.detailValue}>{weather.windSpeed}{t('kmh')}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>{t('pressure')}</span>
                  <span className={styles.detailValue}>{weather.pressure}{t('hPa')}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>{t('visibility')}</span>
                  <span className={styles.detailValue}>{weather.visibility}{t('km')}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>{t('sunrise')}/{t('sunset')}</span>
                  <span className={styles.detailValue}>{unixToTime(weather.sunrise)}/{unixToTime(weather.sunset)}</span>
                </div>
              </div>
            </div>

            {/* 5-Day Forecast */}
            {forecast.length > 0 && (
              <div className={styles.forecastSection}>
                <h3>{t('forecast')}</h3>
                <div className={styles.forecastList}>
                  {forecast.map((day) => (
                    <div key={day.day} className={styles.forecastDay}>
                      <span className={styles.dayName}>{day.day}</span>
                      <img
                        className={styles.forecastIcon}
                        src={weatherIconUrl(day.icon)}
                        alt={day.description}
                      />
                      <span className={styles.forecastDesc}>{day.description}</span>
                      <div className={styles.forecastTemps}>
                        <span className={styles.tempHigh}>{day.tempHigh}°</span>
                        <span className={styles.tempLow}>{day.tempLow}°</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default WeatherApp;
