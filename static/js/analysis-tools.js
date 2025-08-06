import { map, state, dom, showLoader, hideLoader, profileChart, setProfileChart } from './main.js';

export function addAnalysisLayerToUI(displayName, result, colormap) {
    if (dom.analysisLayersPlaceholder) dom.analysisLayersPlaceholder.style.display = "none";
    const checkboxId = `analysis-check-${result.cache_filename.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const existingCheckbox = document.getElementById(checkboxId);
    if (existingCheckbox) {
        if (!existingCheckbox.checked) existingCheckbox.click();
        return;
    }
    
    const itemDiv = document.createElement("div"); itemDiv.className = "layer-item";
    const label = document.createElement("label"); const input = document.createElement("input");
    input.type = "checkbox"; input.name = "raster-layer"; input.id = checkboxId; input.value = result.cache_filename; 
    
    const layerInfo = { 
        id: result.cache_filename, 
        name: displayName, 
        bands: 1, 
        stats: [{ min: result.stats.min, max: result.stats.max }],
        colormap: colormap
    };
    input.dataset.layerInfo = JSON.stringify(layerInfo);
    
    if (window.handleRasterToggle) input.addEventListener("change", () => window.handleRasterToggle(input));
    label.append(input, ` ${displayName}`); itemDiv.appendChild(label);
    
    dom.analysisLayerList.appendChild(itemDiv);
    input.click();
}

export async function handleDerivativeCalculation(derivativeType) {
    if (!state.currentDEM) {
        alert("Please select a base DEM first.");
        return;
    }
    const typeTitleCase = derivativeType.charAt(0).toUpperCase() + derivativeType.slice(1);
    showLoader(`Calculating ${typeTitleCase}...`);
    try {
        const payload = { dem_filename: state.currentDEM.id };
        const response = await fetch(`/api/calculate_${derivativeType}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || result.error) {
            throw new Error(result.error || `Server error during ${derivativeType} calculation.`);
        }
        const layerDisplayName = `${typeTitleCase} (${state.currentDEM.name})`;
        const colormap = derivativeType === 'slope' ? 'slope' : 'hsv'; // HSV is good for aspect
        addAnalysisLayerToUI(layerDisplayName, result, colormap);
        alert(`${typeTitleCase} map generated and added to the 'Generated Layers' list.`);
    } catch (error) {
        alert(`Failed to generate ${typeTitleCase} map: ${error.message}`);
        console.error(error);
    } finally {
        hideLoader();
    }
}

export async function handleLandslideAnalysis() {
    if (!state.currentDEM) {
        alert("Please select a base DEM first.");
        return;
    }
    const rainfall = parseFloat(dom.hazardRainfallInput.value);
    if (isNaN(rainfall) || rainfall < 0) {
        alert("Please enter a valid, non-negative rainfall amount.");
        return;
    }
    showLoader("Calculating Landslide Hazard...");
    try {
        const payload = { dem_filename: state.currentDEM.id, rainfall_mm: rainfall };
        const response = await fetch("/api/landslide_hazard", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || result.error) {
            throw new Error(result.error || "Server error during analysis.");
        }
        const layerDisplayName = `Landslide Hazard (${rainfall}mm)`;
        addAnalysisLayerToUI(layerDisplayName, result, 'YlOrRd');
        alert(`Landslide Hazard map generated and added to the 'Generated Layers' list.`);
    } catch (error) {
        alert("Failed to generate landslide map: " + error.message);
        console.error(error);
    } finally {
        hideLoader();
    }
}

// --- Profile Tool ---
export function toggleProfileTool() {
    if (state.isMeasuring) toggleMeasureTool();

    state.isProfiling = !state.isProfiling;
    dom.profileTool.classList.toggle("active", state.isProfiling);
    map.getCanvas().style.cursor = state.isProfiling ? "crosshair" : "";
    
    resetProfileState();

    if (state.isProfiling) {
        hideProfileChart();
        map.on('click', handleProfileClick);
        map.on('dblclick', handleProfileDoubleClick);
        dom.elevationInfo.innerHTML = "Click to add points. Double-click on the last point to generate profile.";
        if (!map.getSource("profile-draw-source")) {
            map.addSource("profile-draw-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
            map.addLayer({ id: "profile-draw-line", type: "line", source: "profile-draw-source", paint: { "line-color": "#fbb03b", "line-width": 3, "line-dasharray": [2, 2] } });
            map.addLayer({ id: "profile-draw-points", type: "circle", source: "profile-draw-source", paint: { "circle-radius": 6, "circle-color": "#fbb03b" } });
        }
    } else {
        map.off('click', handleProfileClick);
        map.off('dblclick', handleProfileDoubleClick);
    }
}

export function handleProfileClick(e) {
    if (!state.isProfiling) return;
    state.profilePoints.push([e.lngLat.lng, e.lngLat.lat]);
    updateProfileVisuals();
}

function handleProfileDoubleClick(e) {
    if (!state.isProfiling) return;
    e.preventDefault(); 
    if (state.profilePoints.length < 2) {
        toggleProfileTool(); // Just turn it off if not enough points
        return;
    }
    generateProfile();
}

function updateProfileVisuals() {
    const source = map.getSource("profile-draw-source");
    if (!source) return;
    const features = [];
    if (state.profilePoints.length > 0) {
        state.profilePoints.forEach(p => features.push(turf.point(p)));
        if (state.profilePoints.length > 1) {
            features.push(turf.lineString(state.profilePoints));
        }
    }
    source.setData(turf.featureCollection(features));
}

async function generateProfile() {
    if (!state.currentDEM || state.profilePoints.length < 2) {
        toggleProfileTool();
        return;
    }

    showLoader("Generating Elevation Profile...");
    state.profileLineGeoJSON = turf.lineString(state.profilePoints);

    try {
        const payload = { dem_filename: state.currentDEM.id, line: state.profilePoints };
        const response = await fetch("/api/generate_profile", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: "Server returned a non-JSON error." }));
            throw new Error(errorData.error || `Server responded with status ${response.status}`);
        }
        const result = await response.json();
        if (!result.profile_data) {
             throw new Error("The server response is missing 'profile_data'.");
        }
        displayProfileChart(result.profile_data);

        if (map.getSource("profile-draw-source")) map.getSource("profile-draw-source").setData({ type: "FeatureCollection", features: [] });
        if (!map.getSource("profile-line-source")) {
            map.addSource("profile-line-source", { type: "geojson", data: state.profileLineGeoJSON });
            map.addLayer({ id: "profile-line-final", type: "line", source: "profile-line-source", paint: { "line-color": "#e55e5e", "line-width": 4 } });
        } else {
            map.getSource("profile-line-source").setData(state.profileLineGeoJSON);
        }
    } catch (error) {
        console.error("ERROR during profile generation:", error);
        alert("Failed to generate profile: " + error.message);
        hideProfileChart();
    } finally {
        toggleProfileTool(); // Turn off the tool after generating
        hideLoader();
    }
}

function resetProfileState() {
    state.profilePoints = [];
    state.profileLineGeoJSON = null;
    if (map.getSource("profile-draw-source")) {
        map.getSource("profile-draw-source").setData({ type: "FeatureCollection", features: [] });
    }
}

export function hideProfileChart() {
    if (profileChart) {
        profileChart.destroy();
        setProfileChart(null);
    }
    if (dom.profileContainer) dom.profileContainer.classList.remove("visible");
    if (map.getLayer("profile-line-final")) map.removeLayer("profile-line-final");
    if (map.getSource("profile-line-source")) map.removeSource("profile-line-source");
    if (map.getLayer("profile-marker")) map.removeLayer("profile-marker");
    if (map.getSource("profile-marker-source")) map.removeSource("profile-marker-source");
    if(window.profileMarkerPopup) window.profileMarkerPopup.remove();
}

function calculateProfileStats(profileData, distances) {
    if (profileData.length < 2) return null;
    let totalGain = 0, totalLoss = 0, maxSlope = 0;
    const elevations = profileData.map(p => p.elev).filter(e => e !== null);
    if (elevations.length === 0) return null;

    const minElev = Math.min(...elevations), maxElev = Math.max(...elevations);
    const avgElev = elevations.reduce((a, b) => a + b, 0) / elevations.length;

    for (let i = 1; i < profileData.length; i++) {
        const p1 = profileData[i - 1], p2 = profileData[i];
        if (p1.elev === null || p2.elev === null) continue;
        const elevDiff = p2.elev - p1.elev;
        (elevDiff > 0) ? totalGain += elevDiff : totalLoss += Math.abs(elevDiff);
        const distDiff = distances[i] - distances[i-1];
        if (distDiff > 0) maxSlope = Math.max(maxSlope, Math.abs(elevDiff / distDiff) * 100);
    }
    return {
        minElev: minElev.toFixed(0), maxElev: maxElev.toFixed(0), avgElev: avgElev.toFixed(0),
        totalGain: totalGain.toFixed(0), totalLoss: totalLoss.toFixed(0), maxSlope: maxSlope.toFixed(1),
        totalDistance: (distances[distances.length - 1] / 1000).toFixed(2),
    };
}

function displayProfileChart(data) {
    dom.profileContainer.classList.add("visible");
    let cumulativeDistance = 0;
    const distances = [0];
    for (let i = 1; i < data.length; i++) {
        cumulativeDistance += turf.distance([data[i-1].lon, data[i-1].lat], [data[i].lon, data[i].lat], {units: 'meters'});
        distances.push(cumulativeDistance);
    }
    
    const stats = calculateProfileStats(data, distances);
    if (stats) {
        dom.profileStats.innerHTML = `
            <span>Range: <strong>${stats.totalDistance} km</strong></span>
            <span>Min/Avg/Max: <strong>${stats.minElev}m / ${stats.avgElev}m / ${stats.maxElev}m</strong></span>
            <span>Gain/Loss: <strong>+${stats.totalGain}m / -${stats.totalLoss}m</strong></span>
            <span>Max Slope: <strong>${stats.maxSlope}%</strong></span>
        `;
    }

    const verticalLinePlugin = {
        id: 'verticalLine',
        afterDraw: chart => {
            if (chart.tooltip?._active?.length) {
                const ctx = chart.ctx;
                ctx.save();
                const x = chart.tooltip._active[0].element.x;
                const topY = chart.scales.y.top; const bottomY = chart.scales.y.bottom;
                ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, bottomY);
                ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(150, 150, 150, 0.7)';
                ctx.stroke(); ctx.restore();
            }
        }
    };

    dom.profileChartCanvas.profileData = data;
    dom.profileChartCanvas.distances = distances;

    const newProfileChart = new Chart(dom.profileChartCanvas, {
        type: "line",
        data: {
            labels: distances,
            datasets: [{ 
                label: "Elevation (m)", data: data.map(p => p.elev), 
                borderColor: "#A63A3A", backgroundColor: "rgba(200, 90, 90, 0.2)",
                fill: true, pointRadius: 0, tension: 0.1, borderWidth: 2, spanGaps: true 
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: "index" },
            plugins: { verticalLine: true, legend: { display: false }, tooltip: { enabled: true } },
            scales: { 
                x: { type: "linear", title: { display: true, text: "Distance (km)" }, ticks: { callback: v => (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) } }, 
                y: { title: { display: true, text: "Elevation (m)" } } 
            },
            onHover: (event, chartElements) => {
                if(window.profileMarkerPopup) window.profileMarkerPopup.remove();
                if (chartElements.length === 0) {
                    if (map.getLayer("profile-marker")) map.setLayoutProperty("profile-marker", "visibility", "none");
                    return;
                }
                const index = chartElements[0].index;
                const pointData = dom.profileChartCanvas.profileData[index];
                if(pointData) updateProfileMarker([pointData.lon, pointData.lat]);
            },
        },
        plugins: [verticalLinePlugin]
    });
    setProfileChart(newProfileChart);
}

export function updateProfileMarker(coords) {
    const markerGeoJSON = turf.point(coords);
    if (!map.getSource("profile-marker-source")) {
        map.addSource("profile-marker-source", { type: "geojson", data: markerGeoJSON });
        map.addLayer({ 
            id: "profile-marker", source: "profile-marker-source", type: "circle", 
            paint: { "circle-radius": 8, "circle-color": "#e55e5e", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } 
        });
    } else {
        map.getSource("profile-marker-source").setData(markerGeoJSON);
        if (map.getLayer("profile-marker")) map.setLayoutProperty("profile-marker", "visibility", "visible");
    }
}

// --- Measure Tool ---
export function toggleMeasureTool() {
    if (state.isProfiling) toggleProfileTool();
    state.isMeasuring = !state.isMeasuring;
    dom.measureTool.classList.toggle("active", state.isMeasuring);
    map.getCanvas().style.cursor = state.isMeasuring ? "crosshair" : "";
    
    if (state.isMeasuring) {
        map.on('click', handleMeasureClick);
        map.on('dblclick', (e) => { e.preventDefault(); toggleMeasureTool(); });
        dom.measureInfo.innerHTML = "Click to add points. Double-click to end.";
        dom.measureInfo.style.display = "block";
        if (!map.getSource("measure-source")) {
            map.addSource("measure-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
            map.addLayer({ id: "measure-path", type: "line", source: "measure-source", paint: { "line-color": "#ffcc00", "line-width": 3, "line-dasharray": [2, 1] } });
            map.addLayer({ id: "measure-points", type: "circle", source: "measure-source", paint: { "circle-radius": 5, "circle-color": "#ffcc00", "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
        }
    } else {
        map.off('click', handleMeasureClick);
        state.measurePoints = [];
        updateMeasurementVisuals();
        dom.measureInfo.style.display = "none";
    }
}

export function handleMeasureClick(e) {
    if (!state.isMeasuring) return;
    const elevation = map.queryTerrainElevation(e.lngLat, { exaggerated: false });
    if (elevation === null) return;
    state.measurePoints.push([e.lngLat.lng, e.lngLat.lat, elevation]);
    updateMeasurementVisuals();
    updateMeasurementDisplay();
}

function updateMeasurementVisuals() {
    const source = map.getSource("measure-source");
    if (!source) return;
    const features = [];
    if (state.measurePoints.length > 0) {
        features.push(turf.featureCollection(state.measurePoints.map(p => turf.point([p[0],p[1]]))));
        if (state.measurePoints.length > 1) {
            features.push(turf.lineString(state.measurePoints.map(p => [p[0], p[1]])));
        }
    }
    source.setData(turf.featureCollection(features));
}

function updateMeasurementDisplay() {
    if (state.measurePoints.length < 2) {
        dom.measureInfo.innerHTML = "Click to add more points...";
        return;
    };
    
    let totalHorizontalDist = turf.length(turf.lineString(state.measurePoints.map(p => [p[0],p[1]])), {units: 'kilometers'});
    const verticalHeight = state.measurePoints[state.measurePoints.length - 1][2] - state.measurePoints[0][2];
    const slope = totalHorizontalDist > 0 ? (verticalHeight / (totalHorizontalDist * 1000)) * 100 : 0;
    
    dom.measureInfo.innerHTML = `Dist: <b>${totalHorizontalDist.toFixed(2)} km</b> | ΔH: <b>${verticalHeight.toFixed(1)} m</b> | Slope: <b>${slope.toFixed(1)}%</b>`;
}