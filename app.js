// ---------------------------------------------------- 
// PWA Installation & Service Worker
// ---------------------------------------------------- 
let deferredPrompt;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.error("SW Registration failed:", err));
}

window.addEventListener('DOMContentLoaded', () => {
    const installCard = document.getElementById('install-prompt');
    const installBtn = document.getElementById('install-btn');
    const installClose = document.getElementById('install-close');
    const instructions = document.getElementById('install-instructions');

    // Check if app is already installed/running in standalone mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) return; 

    // iOS Detection
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (isIOS) {
        // Apple does not support the native install button, so we provide manual instructions
        installCard.classList.remove('hidden');
        installBtn.style.display = 'none';
        instructions.innerHTML = `To install, tap the <strong>Share</strong> icon below and select <strong>Add to Home Screen</strong>.`;
    }

    // Android/Chrome Detection (Catches the native install prompt)
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        installCard.classList.remove('hidden');
    });

    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') installCard.classList.add('hidden');
                deferredPrompt = null;
            }
        });
    }

    if (installClose) {
        installClose.addEventListener('click', () => {
            installCard.classList.add('hidden');
        });
    }
});

document.addEventListener("DOMContentLoaded", () => {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(fetchWeather, handleLocationError);
    } else {
        document.getElementById("location-name").innerText = "Location support needed.";
    }

    // Custom Pull-to-Refresh Logic
    const main = document.getElementById('app-container');
    const ptr = document.getElementById('pull-to-refresh');
    const spinner = ptr.querySelector('.spinner');
    
    let touchStartY = 0;
    let isDragging = false;
    let isRefreshing = false;

    // 1. Record where the thumb starts
    main.addEventListener('touchstart', (e) => {
        // <= 0 catches edge cases where iOS might leak a negative scroll pixel
        if (main.scrollTop <= 0 && !isRefreshing) {
            touchStartY = e.touches[0].clientY;
            isDragging = true;
            main.classList.add('dragging');
        }
    }, { passive: true });

    // 2. Take over the drag physics
    main.addEventListener('touchmove', (e) => {
        if (!isDragging || isRefreshing) return;
        
        const currentY = e.touches[0].clientY;
        const deltaY = currentY - touchStartY;

        // If pulling down while at the absolute top
        if (deltaY > 0 && main.scrollTop <= 0) {
            // Only stop native scrolling if we are actively pulling down
            if (e.cancelable) e.preventDefault(); 
            
            const dragDistance = Math.min(deltaY * 0.4, 200); 
            main.style.transform = `translateY(${dragDistance}px)`;
            
            // NEW: Keep spinner completely hidden until pulled down 90px
            let pullOpacity = 0;
            if (deltaY > 180) {
                // Fade in smoothly between 90px and 150px of drag
                pullOpacity = Math.min((deltaY - 180) / 140, 1);
            }
            
            ptr.style.opacity = pullOpacity;
            ptr.style.transform = `translateY(${dragDistance * 0.5}px)`;
            spinner.style.transform = `rotate(${deltaY * 2}deg)`;
        }
    }, { passive: false });

    // 3. Release and evaluate
    main.addEventListener('touchend', (e) => {
        if (!isDragging || isRefreshing) return;
        isDragging = false;
        main.classList.remove('dragging');
        
        const currentY = e.changedTouches[0].clientY;
        const deltaY = currentY - touchStartY;

        // NEW: Increased threshold from 70px to 150px
        if (deltaY > 300 && main.scrollTop <= 0) {
            isRefreshing = true;
            
            main.style.transform = `translateY(60px)`;
            ptr.style.transform = `translateY(30px)`;
            spinner.classList.add('spinning');
            
            refreshDataSeamlessly();
        } else {
            resetPullToRefresh();
        }
    });

    function resetPullToRefresh() {
        main.style.transform = `translateY(0px)`;
        ptr.style.opacity = 0;
        ptr.style.transform = `translateY(0px)`;
        spinner.classList.remove('spinning');
        isRefreshing = false;
    }

    function refreshDataSeamlessly() {
        if ("geolocation" in navigator) {
            navigator.geolocation.getCurrentPosition(async (pos) => {
                // Background fetch; UI stays locked until finished
                await fetchWeather(pos); 
                resetPullToRefresh(); 
            }, (err) => {
                handleLocationError(err);
                resetPullToRefresh();
            });
        } else {
            resetPullToRefresh();
        }
    }
});

async function fetchWeather(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    
    const locationEl = document.getElementById("location-name");
    const tempEl = document.getElementById("current-temp");
    const forecastEl = document.getElementById("short-forecast");
    const detailedEl = document.getElementById("detailed-forecast");
    
    try {
        // 1. Get endpoints
        const pointsResponse = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
        if (!pointsResponse.ok) throw new Error("Failed point lookup");
        const pointsData = await pointsResponse.json();
        
        const city = pointsData.properties.relativeLocation.properties.city;
        const state = pointsData.properties.relativeLocation.properties.state;
        locationEl.innerText = `${city}, ${state}`;

        // 2. Fetch All Parallel Data (NWS, Astro, and Open-Meteo)
        const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const todayStr = localDateStr(new Date());
        const tmrw = new Date();
        tmrw.setDate(tmrw.getDate() + 1);
        const tmrwStr = localDateStr(tmrw);

        const fetchJson = (url) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);

        const astroTodayPromise = fetchJson(`https://api.sunrise-sunset.org/v2?lat=${lat}&lng=${lon}&date=${todayStr}`);
        const astroTomorrowPromise = fetchJson(`https://api.sunrise-sunset.org/v2?lat=${lat}&lng=${lon}&date=${tmrwStr}`);
        const gridPromise = fetchJson(pointsData.properties.forecastGridData); 
        
        // NEW: Open-Meteo UV and Air Quality fetches
        // Pull both the exact current UV reading and the daily max
        const uvPromise = fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=uv_index&daily=uv_index_max&timezone=auto`);
        const aqiPromise = fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi`);

        loadHourly(pointsData.properties.forecastHourly, astroTodayPromise, astroTomorrowPromise);

        const [forecastResponse, stationsData, rawAstroToday, rawAstroTomorrow, gridData, uvData, aqiData] = await Promise.all([
            fetch(pointsData.properties.forecast),
            fetchJson(pointsData.properties.observationStations),
            astroTodayPromise,
            astroTomorrowPromise,
            gridPromise,
            uvPromise,
            aqiPromise
        ]);

        const forecastData = await forecastResponse.json();
        const astroData = (rawAstroToday && (rawAstroToday.days ? rawAstroToday.days[0] : rawAstroToday)) || {};
        const astroTomorrowData = (rawAstroTomorrow && (rawAstroTomorrow.days ? rawAstroTomorrow.days[0] : rawAstroTomorrow)) || {};

        // 3. Grid Data Extractors for Exact Location Estimates
        const getGridDaily = (nwsArray) => {
            if (!nwsArray || !nwsArray.values) return null;
            const today = new Date().toLocaleDateString();
            for (let item of nwsArray.values) {
                // NWS ValidTime format: "2026-10-12T13:00:00+00:00/PT11H"
                if (new Date(item.validTime.split('/')[0]).toLocaleDateString() === today) {
                    return Math.round((item.value * 9/5) + 32);
                }
            }
            return null;
        };

        const getGridCurrent = (nwsArray) => {
            if (!nwsArray || !nwsArray.values) return null;
            const now = new Date().getTime();
            let val = null;
            for (let item of nwsArray.values) {
                if (new Date(item.validTime.split('/')[0]).getTime() <= now) val = item.value;
                else break; // Array is chronological; stop once we pass the current time
            }
            return val; // Returns the raw value (Celsius, %, or km/h)
        };

        // 4. Station Observation (Used for wind/humidity, and temperature fallback)
        let obs = {};
        try {
            const stationId = stationsData.features[0].id;
            const observationData = await fetchJson(`${stationId}/observations/latest`);
            obs = (observationData && observationData.properties) || {};
        } catch (e) {
            console.warn("No station observation available", e);
        }
        const val = (key) => (obs[key] && obs[key].value !== undefined ? obs[key].value : null);

        const cToF = (c) => Math.round((c * 9/5) + 32);
        const kmhToMph = (kmh) => Math.round(kmh / 1.609);
        const paToInhg = (pa) => (pa * 0.0002953).toFixed(2);
        const mToMi = (m) => Math.round(m / 1609.34);
        
        const formatTime = (iso) => {
            if (!iso) return "--:--"; 
            return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        };

        // 5. Update UI (Localized Grid Temp, Wind, Humidity, and Feels Like)
        let rawTempC = getGridCurrent(gridData?.properties?.temperature);
        let rawApparentC = getGridCurrent(gridData?.properties?.apparentTemperature); 
        let gridWind = getGridCurrent(gridData?.properties?.windSpeed);
        let gridHum = getGridCurrent(gridData?.properties?.relativeHumidity);
        
        let localCurrentTemp = rawTempC !== null ? cToF(rawTempC) : (val('temperature') !== null ? cToF(val('temperature')) : null);
        let apparentTemp = rawApparentC !== null ? cToF(rawApparentC) : null;
        
        tempEl.innerText = localCurrentTemp !== null ? `${localCurrentTemp}°` : "--°";
        
        const feelsLikeEl = document.getElementById("feels-like");
        if (feelsLikeEl) {
            feelsLikeEl.innerText = apparentTemp !== null ? `Feels like ${apparentTemp}°` : "";
        }
        
        document.getElementById("humidity").innerText = gridHum !== null ? `${Math.round(gridHum)}%` : "--%";
        document.getElementById("wind").innerText = gridWind !== null ? `${kmhToMph(gridWind)} mph` : "-- mph";
        document.getElementById("pressure").innerText = val('barometricPressure') !== null ? `${paToInhg(val('barometricPressure'))} inHg` : "-- inHg";
        document.getElementById("visibility").innerText = val('visibility') !== null ? `${mToMi(val('visibility'))} mi` : "-- mi";

        // NEW: Inject Air Quality & UV Index
        const aqi = aqiData?.current?.us_aqi;
        if (aqi !== undefined && aqi !== null) {
            document.getElementById("aqi-value").innerText = aqi;
            const aqiDesc = document.getElementById("aqi-desc");
            if (aqi <= 50) { aqiDesc.innerText = "Good"; aqiDesc.style.color = "#a8e05f"; }
            else if (aqi <= 100) { aqiDesc.innerText = "Moderate"; aqiDesc.style.color = "#fdd64b"; }
            else if (aqi <= 150) { aqiDesc.innerText = "Unhealthy for Sensitive Groups"; aqiDesc.style.color = "#ff9b57"; }
            else if (aqi <= 200) { aqiDesc.innerText = "Unhealthy"; aqiDesc.style.color = "#fe6a69"; }
            else { aqiDesc.innerText = "Hazardous"; aqiDesc.style.color = "#a97abc"; }
        }

        // UV Index (Current and Max)
        const uvCurrent = uvData?.current?.uv_index;
        const uvMax = uvData?.daily?.uv_index_max?.[0];

        if (uvCurrent !== undefined && uvCurrent !== null) {
            const uvRounded = Math.round(uvCurrent);
            document.getElementById("uv-current").innerText = uvRounded;
            
            // Base the text severity on the current live risk
            const uvDesc = document.getElementById("uv-desc");
            if (uvRounded <= 2) { uvDesc.innerText = "Low"; uvDesc.style.color = "#a8e05f"; }
            else if (uvRounded <= 5) { uvDesc.innerText = "Moderate"; uvDesc.style.color = "#fdd64b"; }
            else if (uvRounded <= 7) { uvDesc.innerText = "High"; uvDesc.style.color = "#ff9b57"; }
            else if (uvRounded <= 10) { uvDesc.innerText = "Very High"; uvDesc.style.color = "#fe6a69"; }
            else { uvDesc.innerText = "Extreme"; uvDesc.style.color = "#a97abc"; }
        }

        if (uvMax !== undefined && uvMax !== null) {
            document.getElementById("uv-max").innerText = Math.round(uvMax);
        }
        
        // 6. Update UI (Forecast Data & Permanent High/Low)
        const p0 = forecastData.properties.periods[0];
        const p1 = forecastData.properties.periods[1];
        
        // Get permanent calendar day high/low from Grid, fallback to text periods if missing
        let trueHigh = getGridDaily(gridData?.properties?.maxTemperature);
        let trueLow = getGridDaily(gridData?.properties?.minTemperature);
        
        if (trueHigh === null) trueHigh = p0.isDaytime ? p0.temperature : p1.temperature;
        if (trueLow === null) trueLow = p0.isDaytime ? p1.temperature : p0.temperature;
        
        document.getElementById("high-low").innerText = `H: ${trueHigh}°  L: ${trueLow}°`;
        
        forecastEl.innerText = p0.shortForecast;
        detailedEl.innerText = p0.detailedForecast;

        // Toggle detailed text on tap of the invisible hit-box
        const forecastToggle = document.getElementById("forecast-toggle");
        const detailedDrawer = document.getElementById("detailed-forecast-container");

        if (forecastToggle && detailedDrawer) {
            // Prevent duplicated event listeners if the data refreshes
            forecastToggle.onclick = () => {
                forecastToggle.classList.toggle("open");
                detailedDrawer.classList.toggle("open");
            };
        }

        // Extended Forecast Setup
        const extendedContainer = document.getElementById("extended-forecast-content");
        const extendedCard = document.getElementById("extended-forecast");
        
        if (extendedContainer && forecastData.properties.periods) {
            extendedContainer.innerHTML = '';
            
            // Always start at index 1 to show the very next period (Tonight if it's day, Tomorrow if it's night)
            const extendedPeriods = forecastData.properties.periods.slice(1);
            
            extendedPeriods.forEach(period => {
                const icon = getHourlyIcon(period.shortForecast, period.isDaytime);
                const tempLabel = period.isDaytime ? `H: ${period.temperature}°` : `L: ${period.temperature}°`;
                const detailedText = period.detailedForecast || period.shortForecast;
                
                const itemDiv = document.createElement('div');
                itemDiv.className = 'extended-item';
                
                itemDiv.innerHTML = `
                    <div class="extended-row-main">
                        <div class="extended-icon">${icon}</div>
                        <div class="extended-details">
                            <div class="extended-name">${period.name}</div>
                            <div class="extended-desc">${period.shortForecast}</div>
                        </div>
                        <div class="extended-temp">${tempLabel}</div>
                    </div>
                    <div class="extended-detailed-text">${detailedText}</div>
                `;

                // Expand/collapse individual row on tap without toggling the main card
                itemDiv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    itemDiv.classList.toggle('row-expanded');
                });

                extendedContainer.appendChild(itemDiv);
            });

            // Toggle main accordion card and reset sub-drawers on close
            extendedCard.onclick = () => {
                const isClosing = extendedCard.classList.contains('expanded');
                extendedCard.classList.toggle('expanded');

                if (isClosing) {
                    const expandedRows = extendedContainer.querySelectorAll('.row-expanded');
                    expandedRows.forEach(row => row.classList.remove('row-expanded'));
                }
            };
        }
        
        // 7. Inject Astro Data into Cards and Sky
        const phaseString = astroData.phase || astroData.moon_phase || "--";
        
        document.getElementById("sunrise").innerText = formatTime(astroData.sunrise);
        document.getElementById("sunset").innerText = formatTime(astroData.sunset);
        document.getElementById("moonrise").innerText = formatTime(astroData.moonrise);
        document.getElementById("moonset").innerText = formatTime(astroData.moonset);
        document.getElementById("moon-phase").innerText = phaseString;
        
        const moonEl = document.querySelector('.moon');
        if (moonEl) moonEl.style.backgroundImage = `url('${getMoonGraphic(phaseString)}')`;
        
        // 8. Run dynamic background and exact arc calculations
        applyDynamicBackground(p0.shortForecast, p0.isDaytime);
        calculateCelestialArcs(astroData, p0.isDaytime);

        // 9. Trigger Photorealistic Weather Engines
        const currentWindMph = gridWind !== null ? kmhToMph(gridWind) : 5;
        updateClouds(p0.shortForecast, currentWindMph);
        startWeatherEffects(p0.shortForecast, currentWindMph);

    } catch (error) {
        console.error(error);
        locationEl.innerText = "Error loading data";
        tempEl.innerText = "--°";
        forecastEl.innerText = "Check network.";
    }
}
// ---------------------------------------------------- 
// Hourly forecast (independent of everything else)
// ---------------------------------------------------- 
function getHourlyIcon(shortForecast, isDaytime) {
    const desc = (shortForecast || "").toLowerCase();
    if (desc.includes("thunder") || desc.includes("storm")) return "⛈️";
    if (desc.includes("snow") || desc.includes("blizzard") || desc.includes("flurries") || desc.includes("sleet")) return "❄️";
    if (desc.includes("rain") || desc.includes("shower") || desc.includes("drizzle")) return "🌧️";
    if (desc.includes("fog") || desc.includes("haze") || desc.includes("smoke")) return "🌫️";
    if (desc.includes("mostly cloudy") || desc.includes("overcast")) return "☁️";
    if (desc.includes("partly") || desc.includes("cloud")) return isDaytime ? "⛅" : "☁️";
    if (desc.includes("mostly clear") || desc.includes("mostly sunny")) return isDaytime ? "🌤️" : "🌙";
    if (desc.includes("clear") || desc.includes("sunny")) return isDaytime ? "☀️" : "🌙";
    if (desc.includes("wind") || desc.includes("breezy")) return "💨";
    return isDaytime ? "☀️" : "🌙";
}

async function loadHourly(hourlyUrl, astroTodayPromise, astroTomorrowPromise) {
    const container = document.getElementById('hourly-forecast-container');
    if (!container) return;

    try {
        // Await NWS hourly data and Astro data concurrently
        const [response, rawAstroToday, rawAstroTomorrow] = await Promise.all([
            fetch(hourlyUrl),
            astroTodayPromise,
            astroTomorrowPromise
        ]);

        if (!response.ok) throw new Error(`Hourly request failed: ${response.status}`);
        const data = await response.json();
        const periods = data && data.properties && data.properties.periods;
        if (!periods || !periods.length) throw new Error("No hourly periods returned");

        const astroData = (rawAstroToday && (rawAstroToday.days ? rawAstroToday.days[0] : rawAstroToday)) || {};
        const astroTomorrowData = (rawAstroTomorrow && (rawAstroTomorrow.days ? rawAstroTomorrow.days[0] : rawAstroTomorrow)) || {};

        container.innerHTML = '';
        let timeline = [];

        // 1. Process Hourly Periods
        periods.slice(0, 24).forEach(period => {
            const temp = period.temperature !== null && period.temperature !== undefined ? `${period.temperature}°` : "--°";
            const pop = period.probabilityOfPrecipitation && period.probabilityOfPrecipitation.value;
            const precipStr = pop > 0 ? `${pop}%` : "";
            const icon = getHourlyIcon(period.shortForecast, period.isDaytime);

            timeline.push({
                type: 'hour',
                time: new Date(period.startTime),
                temp: temp,
                icon: icon,
                precipStr: precipStr
            });
        });

        // 2. Add Sunrise and Sunset Events
        [astroData, astroTomorrowData].forEach(astro => {
            if (astro && astro.sunrise) {
                timeline.push({ type: 'astro', label: 'Sunrise', time: new Date(astro.sunrise), icon: '🌅' });
            }
            if (astro && astro.sunset) {
                timeline.push({ type: 'astro', label: 'Sunset', time: new Date(astro.sunset), icon: '🌇' });
            }
        });

        // 3. Sort Chronologically
        timeline.sort((a, b) => a.time - b.time);

        // 4. Establish exact 24-Hour Boundaries
        const firstHourTime = timeline.find(item => item.type === 'hour').time.getTime();
        const endWindowTime = firstHourTime + (24 * 60 * 60 * 1000);

        // 5. Render Timeline
        timeline.forEach(item => {
            const itemTime = item.time.getTime();
            
            // Only inject events that happen within the exact next 24 hours
            if (itemTime >= firstHourTime && itemTime <= endWindowTime) {
                const hourDiv = document.createElement('div');
                hourDiv.className = 'hourly-item';
                
                if (item.type === 'hour') {
                    const timeStr = item.time.toLocaleTimeString([], { hour: 'numeric' });
                    hourDiv.innerHTML = `
                        <div class="hourly-time">${timeStr}</div>
                        <div class="hourly-icon">${item.icon}</div>
                        <div class="hourly-temp">${item.temp}</div>
                        <div class="hourly-precip">${item.precipStr}</div>
                    `;
                } else {
                    const timeStr = item.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    hourDiv.classList.add('hourly-astro');
                    hourDiv.innerHTML = `
                        <div class="hourly-time">${timeStr}</div>
                        <div class="hourly-icon" style="font-size:26px;">${item.icon}</div>
                        <div class="hourly-temp">${item.label}</div>
                        <div class="hourly-precip"></div>
                    `;
                }
                container.appendChild(hourDiv);
            }
        });
    } catch (err) {
        console.error("Hourly forecast error:", err);
        container.innerHTML = '<div class="hourly-item" style="width:100%; text-align:center;">Hourly forecast unavailable</div>';
    }
}

// ---------------------------------------------------- 
// Helper: Map NWS text to specific condition classes
// ---------------------------------------------------- 
function applyDynamicBackground(forecastText, isDaytime) {
    const text = forecastText.toLowerCase();
    const body = document.body;

    // Reset all weather classes
    body.className = ''; 

    // Apply Day/Night base class
    if (isDaytime) {
        body.classList.add('is-day');
    } else {
        body.classList.add('is-night');
    }

    // Determine current time for Sunrise/Sunset transition colors
    const hour = new Date().getHours();
    if (isDaytime && hour >= 5 && hour <= 7) {
        body.classList.add('sunrise');
    } else if (isDaytime && hour >= 17 && hour <= 19) {
        body.classList.add('sunset');
    }

    // Granular NWS keyword mapping
    if (text.includes('thunder') || text.includes('storm')) {
        body.classList.add('thunderstorm');
    } else if (text.includes('snow') || text.includes('flurries')) {
        body.classList.add('snow');
    } else if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) {
        body.classList.add('rain');
    } else if (text.includes('mostly cloudy')) {
        body.classList.add('mostly-cloudy');
    } else if (text.includes('partly cloudy') || text.includes('partly sunny')) {
        body.classList.add('partly-cloudy');
    } else if (text.includes('cloudy') || text.includes('overcast')) {
        body.classList.add('cloudy');
    } else if (text.includes('mostly sunny') || text.includes('mostly clear')) {
        body.classList.add('mostly-sunny');
    } else if (text.includes('clear') || text.includes('sun')) {
        body.classList.add('sunny');
    } else {
        body.classList.add('cloudy');
    }
}

// ---------------------------------------------------- 
// Helper: Exact Celestial Arc Math
// ---------------------------------------------------- 
function calculateCelestialArcs(astro, isDaytime) {
    const now = new Date();
    const currentHour = now.getHours() + (now.getMinutes() / 60);
    const body = document.body;

    const getDecimal = (isoStr) => {
        if (!isoStr) return null;
        const d = new Date(isoStr);
        return d.getHours() + (d.getMinutes() / 60);
    };

    // 1. Sun Arc
    const sr = getDecimal(astro.sunrise);
    const ss = getDecimal(astro.sunset);
    
    // Clear any leftover time-of-day transition classes
    body.classList.remove('sunrise', 'sunset');

    if (sr !== null && ss !== null) {
        let sunPct = (currentHour - sr) / (ss - sr);
        sunPct = Math.max(0, Math.min(1, sunPct));
        document.documentElement.style.setProperty('--sun-x', sunPct * 100);
        document.documentElement.style.setProperty('--sun-y', 60 - (Math.sin(sunPct * Math.PI) * 50));

        // Use exact API Golden Hour variables for background transitions
        if (astro.golden_hour) {
            const morningBegin = getDecimal(astro.golden_hour.morning.begin);
            const morningEnd = getDecimal(astro.golden_hour.morning.end);
            const eveningBegin = getDecimal(astro.golden_hour.evening.begin);
            const eveningEnd = getDecimal(astro.golden_hour.evening.end);

            if (currentHour >= morningBegin && currentHour <= morningEnd) {
                body.classList.add('sunrise');
            } else if (currentHour >= eveningBegin && currentHour <= eveningEnd) {
                body.classList.add('sunset');
            }
        }
    }

    // 2. Moon Arc
    const mr = getDecimal(astro.moonrise);
    const ms = getDecimal(astro.moonset);
    if (mr !== null && ms !== null) {
        let duration = ms < mr ? (ms + 24) - mr : ms - mr;
        let elapsed = currentHour < mr ? (currentHour + 24) - mr : currentHour - mr;
        
        if (elapsed <= duration) {
            let moonPct = elapsed / duration;
            document.documentElement.style.setProperty('--moon-x', moonPct * 100);
            document.documentElement.style.setProperty('--moon-y', 60 - (Math.sin(moonPct * Math.PI) * 50));
            const rotation = (moonPct - 0.5) * 180;
            document.documentElement.style.setProperty('--moon-rot', `${rotation}deg`);
            body.classList.add('moon-up');
        } else {
            body.classList.remove('moon-up');
        }
    } else {
        body.classList.remove('moon-up');
    }
}

function handleLocationError(error) {
    document.getElementById("location-name").innerText = "Location denied.";
    console.error(error);
}

// ---------------------------------------------------- 
// Helper: Map API Phase to Image Files
// ---------------------------------------------------- 
function getMoonGraphic(phaseText) {
    if (!phaseText) return 'moon-full.png'; 
    const p = phaseText.toLowerCase();
    
    if (p.includes('new')) return 'moon-new.png';
    if (p.includes('waxing crescent')) return 'moon-waxing-crescent.png';
    if (p.includes('first quarter')) return 'moon-first-quarter.png';
    if (p.includes('waxing gibbous')) return 'moon-waxing-gibbous.png';
    if (p.includes('full')) return 'moon-full.png';
    if (p.includes('waning gibbous')) return 'moon-waning-gibbous.png';
    if (p.includes('last quarter') || p.includes('third quarter')) return 'moon-last-quarter.png';
    if (p.includes('waning crescent')) return 'moon-waning-crescent.png';
    
    return 'moon-full.png';
}

// ---------------------------------------------------- 
// Engine 1: Image-Based Cloud Spawner
// ---------------------------------------------------- 
let lastCloudForecast = null; // NEW: Tracks the current cloud state

function updateClouds(forecastText, windSpeedMph) {
    const text = (forecastText || "").toLowerCase();
    
    // NEW: If the weather hasn't changed, exit immediately without clearing the sky
    if (text === lastCloudForecast) return;
    lastCloudForecast = text;

    const container = document.getElementById('clouds-container');
    if (!container) return;
    
    container.innerHTML = ''; 
    
    let cloudCount = 0;
    let baseOpacity = 0.8;
    let isOvercast = false;

    // Heavily increased cloud density limits
    if (text.includes("clear") || text.includes("sunny")) cloudCount = 0;
    else if (text.includes("mostly clear") || text.includes("mostly sunny")) { cloudCount = 3; baseOpacity = 0.8; }
    else if (text.includes("partly")) { cloudCount = 6; baseOpacity = 0.8; }
    else if (text.includes("mostly cloudy")) { cloudCount = 15; baseOpacity = 0.9; isOvercast = true; }
    else if (text.includes("cloudy") || text.includes("overcast") || text.includes("fog")) { cloudCount = 20; baseOpacity = 1; isOvercast = true; }
    else if (text.includes("rain") || text.includes("snow") || text.includes("storm")) { cloudCount = 25; baseOpacity = 1; isOvercast = true; }

    if (text.includes("fog")) document.body.classList.add('fog');
    else document.body.classList.remove('fog');

    const safeWind = Math.max(windSpeedMph || 5, 1); 
    const baseDuration = Math.max((1500 / safeWind), 20); 

    // 1. Overcast canopy (Now uses 4 staggered layers for dense coverage)
    if (isOvercast) {
        for (let j = 0; j < 10; j++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'cloud-wrapper';
            wrapper.style.width = '150vw'; 
            wrapper.style.height = '65vh'; 
            wrapper.style.top = `${-40 + (j * 3)}vh`; // Stagger vertically
            wrapper.style.animationDuration = `${baseDuration * (2.5 + j * 0.2)}s, ${baseDuration * (2.5 + j * 0.2)}s`; 
            wrapper.style.animationDelay = `${j * -100}s, ${j * -100}s`; // Spread out evenly
            wrapper.style.setProperty('--cloud-opacity', baseOpacity);
            
            const img = document.createElement('div');
            img.className = 'cloud-image';
            
            wrapper.appendChild(img);
            container.appendChild(wrapper);
        }
    }

    // 2. Spawn distinct clouds
    for (let i = 0; i < cloudCount; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'cloud-wrapper';
        
        const scaleX = (Math.random() * 1.5) + 0.8; 
        const scaleY = (Math.random() * 0.8) + 0.5; 
        const topPos = Math.random() * (isOvercast ? 40 : 60); // Let them drop lower into the sky
        const delay = Math.random() * -200; // Better initial distribution
        const finalDuration = baseDuration * (1 / scaleX); 

        wrapper.style.width = `${250 * scaleX}px`;
        wrapper.style.height = `${150 * scaleY}px`;
        wrapper.style.top = `${topPos}vh`;
        wrapper.style.animationDuration = `${finalDuration}s, ${finalDuration}s`;
        wrapper.style.animationDelay = `${delay}s, ${delay}s`;
        wrapper.style.setProperty('--cloud-opacity', baseOpacity);
        
        const img = document.createElement('div');
        img.className = 'cloud-image';
        img.style.transform = `scaleX(${Math.random() > 0.5 ? 1 : -1})`; 
        
        wrapper.appendChild(img);
        container.appendChild(wrapper);
    }
}

// ---------------------------------------------------- 
// Engine 2: Canvas Rain, Snow & Lightning Physics
// ---------------------------------------------------- 
let weatherAnimationId = null;

function startWeatherEffects(forecastText, windSpeedMph) {
    const canvas = document.getElementById('weather-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    if (weatherAnimationId) cancelAnimationFrame(weatherAnimationId);

    let W = window.innerWidth;
    let H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;

    window.addEventListener('resize', () => {
        W = window.innerWidth; H = window.innerHeight;
        canvas.width = W; canvas.height = H;
    });

    const text = (forecastText || "").toLowerCase();
    const isRain = text.includes('rain') || text.includes('shower') || text.includes('drizzle');
    const isSnow = text.includes('snow') || text.includes('flurries') || text.includes('blizzard');
    const isHeavySnow = text.includes('heavy snow') || text.includes('blizzard');
    const isStorm = text.includes('thunder') || text.includes('storm');

    if (!isRain && !isSnow && !isStorm) {
        ctx.clearRect(0, 0, W, H);
        return; 
    }

    const safeWind = Math.max(windSpeedMph || 5, 0);
    const windDrift = safeWind * 0.1; 
    
    // Calculate snow velocity multipliers
    const snowBaseSpeed = isHeavySnow ? 5 : 2;
    const windDownwardForce = safeWind * 0.15; // Wind drives the snow downward faster

    let particles = [];
    // Spawn more particles for heavy snow conditions
    const maxParticles = isSnow ? (isHeavySnow ? 500 : 350) : (isRain ? 150 : 0);
    
    for (let i = 0; i < maxParticles; i++) {
        particles.push({
            x: Math.random() * (W + 800) - 400,
            y: Math.random() * H,
            r: Math.random() * 3 + 1, 
            d: Math.random() * maxParticles, 
            l: Math.random() * 10 + 10, 
            // Apply the velocity multipliers to the vertical speed
            speed: isSnow ? (Math.random() * 3 + snowBaseSpeed + windDownwardForce) : (Math.random() * 12 + 16)
        });
    }

    let lightningTimer = 0;

    function draw() {
        ctx.clearRect(0, 0, W, H);

        // 1. Draw Lightning 
        if (isStorm) {
            lightningTimer++;
            if (lightningTimer > Math.random() * 1400 + 1000) {
                ctx.beginPath();
                let lx = Math.random() * W;
                let ly = 0;
                ctx.moveTo(lx, ly);
                while (ly < H) {
                    lx += (Math.random() - 0.5) * 100;
                    ly += Math.random() * 50 + 20;
                    ctx.lineTo(lx, ly);
                }
                
                ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
                ctx.lineWidth = 4;
                ctx.stroke();
                
                ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
                ctx.shadowBlur = 15;
                ctx.stroke();
                ctx.shadowBlur = 0; 
                
                lightningTimer = 0;
            }
        }

        // 2. Draw Rain or Snow
        if (isRain || isSnow) {
            ctx.fillStyle = isSnow ? "rgba(255, 255, 255, 0.8)" : "rgba(150, 180, 255, 0.6)";
            ctx.strokeStyle = "rgba(150, 180, 255, 0.6)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            
            for (let i = 0; i < maxParticles; i++) {
                let p = particles[i];
                if (isSnow) {
                    ctx.moveTo(p.x, p.y);
                    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2, true);
                } else { 
                    const trailX = p.x - (windDrift * (p.l / p.speed));
                    const trailY = p.y - p.l;
                    ctx.moveTo(p.x, p.y);
                    ctx.lineTo(trailX, trailY);
                }
            }
            isSnow ? ctx.fill() : ctx.stroke();
        }

        // 3. Update Positions 
        for (let i = 0; i < maxParticles; i++) {
            let p = particles[i];
            
            if (isSnow) {
                p.y += (p.speed * 0.5); 
                p.x += windDrift + (Math.sin(p.d + lightningTimer * 0.05) * 0.5); 
            } else { 
                p.y += p.speed;
                p.x += windDrift;
            }

            // Bottom wrap
            if (p.y > H + p.l) {
                p.y = -20;
                p.x = Math.random() * (W + 800) - 400; 
            }
            
            // Edge wrapping 
            if (p.x > W + 400) p.x = -400;
            else if (p.x < -400) p.x = W + 400;
        }

        weatherAnimationId = requestAnimationFrame(draw);
    }
    
    draw();
}

// ---------------------------------------------------- 
// TEMPORARY DEBUG CONTROLS
// ---------------------------------------------------- 
const debugWeather = document.getElementById('test-weather');
const debugWind = document.getElementById('test-wind');
const debugWindVal = document.getElementById('test-wind-val');
const debugTime = document.getElementById('test-time');

if (debugWeather && debugWind && debugTime) {
    function runTests() {
        const w = debugWeather.value;
        const wind = parseInt(debugWind.value);
        const t = parseFloat(debugTime.value);
        
        debugWindVal.innerText = wind;

        // 1. Evaluate Time of Day (Assume Sun up 6am to 7pm)
        const isDaytime = t >= 6 && t < 19;
        const body = document.body;
        
        // Base Sky Colors
        applyDynamicBackground(w, isDaytime);
        
        // Clear time-of-day specific overrides
        body.classList.remove('sunrise', 'sunset', 'moon-up');

        // 2. Arc Physics
        if (isDaytime) {
            // Sun Arc (6am to 7pm = 13 hours total)
            let pct = (t - 6) / 13;
            document.documentElement.style.setProperty('--sun-x', pct * 100);
            document.documentElement.style.setProperty('--sun-y', 60 - (Math.sin(pct * Math.PI) * 50));
            
            if (t >= 6 && t <= 8) body.classList.add('sunrise');
            if (t >= 17 && t <= 19) body.classList.add('sunset');
        } else {
            // Moon Arc (7pm to 6am = 11 hours total)
            let pct = t < 6 ? (t + 5) / 11 : (t - 19) / 11;
            document.documentElement.style.setProperty('--moon-x', pct * 100);
            document.documentElement.style.setProperty('--moon-y', 60 - (Math.sin(pct * Math.PI) * 50));
            body.classList.add('moon-up');
        }

        // 3. Restart Weather Physics
        updateClouds(w, wind);
        startWeatherEffects(w, wind);
    }

    debugWeather.addEventListener('change', runTests);
    debugWind.addEventListener('input', runTests);
    debugTime.addEventListener('input', runTests);
}

// END OF TEMPORARY TESTING CONTROLS