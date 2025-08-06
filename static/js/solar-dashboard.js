// solar-dashboard.js

// --- DOM ELEMENTS ---
const dom = {
    clearSkyChart: document.getElementById('clearSkyChart'),
    cloudySkyChart: document.getElementById('cloudySkyChart'),
    map: document.getElementById('map'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loaderText: document.getElementById('loader-text'),
};

const PUDUKKOTTAI_COORDS = [78.8333, 10.3833];
let map;
let clearSkyChartInstance;
let cloudySkyChartInstance;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
    showLoader("Fetching solar data...");
   
    try {
        const solarData = await fetchSolarData();
        createCharts(solarData);
    } catch (error) {
        console.error("Initialization failed:", error);
        alert("Could not load solar irradiance data. Please check the server and API key.");
    } finally {
        hideLoader();
    }
}



async function fetchSolarData() {
    // This could be expanded to pass different lat/lon from user input
    const response = await fetch(`/api/solar_irradiance?lat=${PUDUKKOTTAI_COORDS[1]}&lon=${PUDUKKOTTAI_COORDS[0]}`);
    if (!response.ok) {
        throw new Error((await response.json()).error || "Server error");
    }
    return await response.json();
}

function createCharts(data) {
    // Prepare labels (timestamps) for the charts
    const labels = data.map(d => d.index);

    // Chart.js configuration
    const chartConfig = (title, datasets) => ({
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'hour',
                        tooltipFormat: 'MMM d, h:mm a',
                        displayFormats: {
                            hour: 'h a'
                        }
                    },
                    title: {
                        display: true,
                        text: 'Date and Time'
                    }
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Solar Irradiance (W/m²)'
                    }
                }
            },
            plugins: {
                title: { display: true, text: title },
                tooltip: { mode: 'index', intersect: false },
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
    
    // Create Clear Sky Chart
    if (clearSkyChartInstance) clearSkyChartInstance.destroy();
    clearSkyChartInstance = new Chart(dom.clearSkyChart, chartConfig('Clear Sky Model', [
        { label: 'GHI', data: data.map(d => ({ x: d.index, y: d.ghi_clear })), borderColor: 'rgb(255, 99, 132)', tension: 0.1, borderWidth: 2, pointRadius: 0 },
        { label: 'DHI', data: data.map(d => ({ x: d.index, y: d.dhi_clear })), borderColor: 'rgb(54, 162, 235)', tension: 0.1, borderWidth: 2, pointRadius: 0 },
        { label: 'DNI', data: data.map(d => ({ x: d.index, y: d.dni_clear })), borderColor: 'rgb(255, 205, 86)', tension: 0.1, borderWidth: 2, pointRadius: 0 },
    ]));

    // Create Cloudy Sky Chart
    if (cloudySkyChartInstance) cloudySkyChartInstance.destroy();
    cloudySkyChartInstance = new Chart(dom.cloudySkyChart, chartConfig('Cloudy Sky Model (DirInt)', [
        { label: 'GHI', data: data.map(d => ({ x: d.index, y: d.ghi_cloudy })), borderColor: 'rgb(148, 87, 235)', tension: 0.1, borderWidth: 2, pointRadius: 0 },
        { label: 'DHI', data: data.map(d => ({ x: d.index, y: d.dhi_cloudy })), borderColor: 'rgb(75, 192, 192)', tension: 0.1, borderWidth: 2, pointRadius: 0 },
        { label: 'DNI', data: data.map(d => ({ x: d.index, y: d.dni_cloudy })), borderColor: 'rgb(255, 159, 64)', tension: 0.1, borderWidth: 2, pointRadius: 0 },
    ]));
}


// --- UTILITY FUNCTIONS ---
function showLoader(text) {
    if(dom.loaderText) dom.loaderText.textContent = text;
    if(dom.loadingOverlay) dom.loadingOverlay.style.display = 'flex';
}
function hideLoader() {
    if(dom.loadingOverlay) dom.loadingOverlay.style.display = 'none';
}