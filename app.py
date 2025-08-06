# app.py

import os
import sys
import tempfile
import zipfile

import matplotlib
from matplotlib import pyplot as plt
from shapely import Point
# Use a non-interactive backend, crucial for server-side execution
matplotlib.use('Agg')
os.environ['MPLCONFIGDIR'] = "/tmp/matplotlib"
# ==============================================================================
# --- STEP 2: IMPORT ALL OTHER LIBRARIES ---
# ==============================================================================

from flask import Flask, abort, render_template, request, jsonify, Response, redirect, send_file, send_from_directory, url_for
from flask_cors import CORS
import glob
import json
import geopandas as gpd
import pandas as pd
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.features import shapes
import numpy as np
from PIL import Image
import io
import mercantile
import traceback
import requests
from skimage.morphology import skeletonize
from dotenv import load_dotenv
from shapely.ops import nearest_points, linemerge, unary_union
from shapely.geometry import shape, box
from mapbox_vector_tile import encode as mvt_encode
from matplotlib import cm
from matplotlib.colors import Normalize, LinearSegmentedColormap
# import richdem as rd  # <-- REMOVED
import pvlib
import pytz
import uuid
from werkzeug.utils import secure_filename
from pysheds.grid import Grid
import pyproj

# --- PDAL Check ---
try:
    import pdal
    print("SUCCESS: PDAL library found.")
except ImportError:
    print("WARNING: PDAL library not found. Point cloud features will be disabled.")
    pdal = None

# ==============================================================================
# --- STEP 3: FLASK APP SETUP AND CONFIGURATION ---
# ==============================================================================
load_dotenv()

app = Flask(__name__)
CORS(app)
MAPTILER_API_KEY = os.environ.get("MAPTILER_API_KEY", "5EYOzE3UHralvJsxc3xw")
NREL_API_KEY = os.environ.get("NREL_API_KEY", "jyAPNa8CEgKFHJOwMUhYYIEJZAdbfbHCIjuyXZo5")

# --- PATHS CONFIGURATION ---
BASE_DATA_PATH = os.path.join(os.getcwd(), "data", "Koushika")
VECTOR_DATA_PATH = os.path.join(BASE_DATA_PATH, "shp")
ELEVATION_DATA_PATH = os.path.join(BASE_DATA_PATH, "elevation")
RASTER_DATA_PATH = os.path.join(BASE_DATA_PATH, "tif")
POINTCLOUD_DATA_PATH = os.path.join(BASE_DATA_PATH, "point")
CACHE_PATH = os.path.join(BASE_DATA_PATH, "cache")
MODEL_DATA_PATH = os.path.join(BASE_DATA_PATH, "models")
GENERIC_DATA_PATH = os.path.join(os.getcwd(), "data")

for path in [VECTOR_DATA_PATH, ELEVATION_DATA_PATH, RASTER_DATA_PATH, POINTCLOUD_DATA_PATH, CACHE_PATH, MODEL_DATA_PATH, GENERIC_DATA_PATH]:
    if not os.path.isdir(path):
        os.makedirs(path)
        print(f"WARNING: Created directory at: {path}")

STATIC_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
UPLOAD_FOLDER = os.path.join(STATIC_FOLDER, 'uploads')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# --- HELPER FUNCTIONS ---
def encode_terrain_rgb(data, nodata_val):
    valid_mask = (data != nodata_val) & np.isfinite(data)
    data[~valid_mask] = 0
    val = (data + 10000.0) * 10.0
    r = np.floor(val / 65536)
    g = np.floor((val % 65536) / 256)
    b = np.floor(val % 256)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)

@app.route('/')
def home():
    return redirect(url_for('viewer'))

@app.route('/viewer')
def viewer():
    return render_template('index.html')

@app.route('/flood_simulation')
def flood_simulation_launcher():
    return render_template('flood-viewer.html')

@app.route('/flood_simulation/<path:dem_id>')
def flood_simulation(dem_id):
    dem_path = os.path.join(ELEVATION_DATA_PATH, dem_id)
    if not os.path.exists(dem_path):
        abort(404, description=f"DEM file '{dem_id}' not found.")
    return render_template('flood-viewer.html', dem_id=dem_id)

@app.route('/point_viewer')
def point_viewer_page():
    return render_template('point.html')


# =========================================================================
# === FLOOD SIMULATION API ROUTES (Most will be disabled due to richdem removal) ===
# =========================================================================

@app.route('/api/run_gis_flood_simulation', methods=['POST'])
def run_gis_flood_simulation():
    # This function relies heavily on richdem and is now disabled.
    return jsonify({"error": "This GIS simulation feature is currently disabled due to library incompatibility."}), 501

    
@app.route('/api/calculate_flow_accumulation', methods=['POST'])
def calculate_flow_accumulation():
    # This function relies heavily on richdem and is now disabled.
    return jsonify({"error": "This flow accumulation feature is currently disabled due to library incompatibility."}), 501

@app.route('/api/trace_flow_path', methods=['POST'])
def trace_flow_path():
    # This function relies heavily on richdem and is now disabled.
    return jsonify({"error": "This flow trace feature is currently disabled due to library incompatibility."}), 501

@app.route('/api/channelized_flood_simulation', methods=['POST'])
def channelized_flood_simulation():
    # This function relies on pysheds and should still work, but may have some richdem dependencies.
    # We will keep it but add a try-except block for safety.
    try:
        data = request.get_json()
        dem_id = data.get('dem_id')
        inflow_points = data.get('inflow_points', [])

        if not dem_id or not inflow_points:
            return jsonify({"error": "DEM ID and inflow points are required."}), 400

        dem_path = os.path.join(ELEVATION_DATA_PATH, dem_id)
        if not os.path.exists(dem_path):
            return jsonify({"error": "DEM file not found."}), 404

        grid = Grid()
        dem = grid.read_raster(dem_path)
        original_nodata = dem.nodata
        
        dem_data = dem.astype('float32')
        dem_data[dem_data == original_nodata] = np.nan
        
        filled_dem_data = grid.fill_depressions(dem_data)
        flow_direction = grid.flowdir(filled_dem_data) # Using pysheds flow direction
        
        flow_direction_mask = flow_direction > 0
        inflow_coords = []
        for p in inflow_points:
            try:
                snapped_coord = grid.snap_to_mask(flow_direction_mask, (p['lon'], p['lat']))
                inflow_coords.append(snapped_coord)
            except Exception as e:
                print(f"Warning: Could not snap point {p}: {e}")
                continue
        
        if not inflow_coords:
            return jsonify({"error": "No valid inflow points after snapping."}), 400
            
        x_coords, y_coords = zip(*inflow_coords)
        acc = grid.accumulation(flow_direction, x=x_coords, y=y_coords)

        total_inflow_rate = sum(p.get('rate', 0) for p in inflow_points if p.get('rate', 0) > 0)
        flood_depth = np.log1p(acc) * (0.05 * (total_inflow_rate / 50) if total_inflow_rate > 0 else 0.05)
        
        wse_raster = np.where(flood_depth > 0.01, dem_data + flood_depth, original_nodata)
        wse_raster[np.isnan(wse_raster)] = original_nodata
        wse_raster = wse_raster.astype('float32')

        cache_filename = f"channel_flood_{uuid.uuid4().hex[:8]}.tif"
        grid.to_raster(wse_raster, os.path.join(CACHE_PATH, cache_filename))

        return jsonify({"status": "success", "cache_filename": cache_filename})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"An error during channelized flood simulation: {str(e)}"}), 500

@app.route('/api/export_channel_flood', methods=['POST'])
def export_channel_flood():
    # This should be fine as it relies on rasterio and shapely.
    data = request.get_json(); cache_filename = data.get('cache_filename')
    if not cache_filename: return jsonify({"error": "Cache filename is required."}), 400
    raster_path = os.path.join(CACHE_PATH, cache_filename)
    if not os.path.exists(raster_path): return jsonify({"error": "Cached raster file not found."}), 404
    try:
        with rasterio.open(raster_path) as src: wse_raster = src.read(1); profile = src.profile; nodata_val = src.nodata
        flood_mask = (wse_raster != nodata_val) & np.isfinite(wse_raster)
        if not np.any(flood_mask): return jsonify({"error": "The raster contains no flood data to export."}), 422
        skeleton = skeletonize(flood_mask)
        features = [{'type': 'Feature', 'geometry': shape(g).boundary.__geo_interface__, 'properties': {}} for g, v in shapes(skeleton.astype(np.uint8), mask=skeleton, transform=profile['transform']) if v == 1]
        if not features: return jsonify({"error": "Could not vectorize the flood path."}), 500
        final_gdf = gpd.GeoDataFrame([1], geometry=[linemerge(unary_union(gpd.GeoDataFrame.from_features(features, crs=profile['crs']).geometry))], crs=profile['crs'])
        with tempfile.TemporaryDirectory() as tmpdir:
            shp_path = os.path.join(tmpdir, 'flood_centerline.shp'); final_gdf.to_file(shp_path, driver='ESRI Shapefile')
            memory_file = io.BytesIO()
            with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in glob.glob(os.path.join(tmpdir, 'flood_centerline.*')): zf.write(f, os.path.basename(f))
            memory_file.seek(0)
            return send_file(memory_file, mimetype='application/zip', as_attachment=True, download_name='channel_flood_centerline.zip')
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": f"An error during shapefile export: {str(e)}"}), 500


@app.route('/api/projection_data', methods=['POST'])
def get_projection_data():
    data = request.get_json(); dem_id = data.get('dem_id'); points = data.get('points', []); rainfall_mm_hr = float(data.get('rainfall_mm_hr', 0.0))
    if not dem_id: return jsonify({"error": "dem_id is required."}), 400
    dem_path = os.path.join(ELEVATION_DATA_PATH, dem_id)
    if not os.path.exists(dem_path): return jsonify({"error": "DEM file not found."}), 404
    try:
        with rasterio.open(dem_path) as src:
            dem_transform = src.transform
            dem_crs = src.crs
            dem_data = src.read(1).astype('float32')
            original_nodata = src.nodata

        dem_data[dem_data == original_nodata] = np.nan
        rd_dem = rd.rdarray(dem_data, no_data=np.nan)
        rd_dem.geotransform = dem_transform.to_gdal()

        filled_dem = rd.FillDepressions(rd_dem, in_place=False)
        aspect = rd.TerrainAttribute(filled_dem, attrib='aspect')

        aspect_map = {
            (337.5, 360): (0, 1), (0, 22.5): (0, 1), (22.5, 67.5): (-1, 1),
            (67.5, 112.5): (-1, 0), (112.5, 157.5): (-1, -1), (157.5, 202.5): (0, -1),
            (202.5, 247.5): (1, -1), (247.5, 292.5): (1, 0), (292.5, 337.5): (1, 1),
        }
        def get_dir_from_aspect(angle):
            if angle < 0: return (0, 0)
            for r, d in aspect_map.items():
                if r[0] <= angle < r[1]: return d
            return (0, 0)

        water_additions = np.zeros_like(filled_dem, dtype=np.float32)
        water_additions[np.isfinite(filled_dem)] += (rainfall_mm_hr * (10 / 60.0)) / 1000.0
        
        transformer = pyproj.Transformer.from_crs("EPSG:4326", dem_crs, always_xy=True)

        for p in points:
            rate = p.get('rate', 0)
            if rate <= 0: continue # Only process inflows
            
            dem_x, dem_y = transformer.transform(p['lon'], p['lat'])
            row, col = rasterio.transform.rowcol(dem_transform, dem_x, dem_y)
            curr_r, curr_c = int(row), int(col)
            
            path_len = 0
            while path_len < 10000:
                if not (0 <= curr_r < water_additions.shape[0] and 0 <= curr_c < water_additions.shape[1]): break
                water_additions[curr_r, curr_c] += (rate * 0.0001) / (path_len + 1)
                angle = aspect[curr_r, curr_c]
                dr, dc = get_dir_from_aspect(angle)
                if dr == 0 and dc == 0: break
                curr_r += dr; curr_c += dc
                path_len += 1
                    
        # === FIX: Use 0 for non-flooded areas instead of nodata ===
        # This ensures the animation colormap has a base and renders correctly.
        flood_depth_raster = np.where(water_additions > 0.01, water_additions, 0)
        # Re-apply the proper nodata mask from the original DEM
        flood_depth_raster[np.isnan(dem_data)] = original_nodata
        
        cache_filename = f"flood_depth_{uuid.uuid4().hex[:8]}.tif"
        output_depth = rd.rdarray(flood_depth_raster.astype(np.float32), no_data=original_nodata)
        output_depth.geotransform = dem_transform.to_gdal()
        rd.SaveGDAL(os.path.join(CACHE_PATH, cache_filename), output_depth)
        
        valid_pixels = flood_depth_raster[flood_depth_raster > 0]
        stats = {
            "min": 0,
            "max": float(np.max(valid_pixels)) if valid_pixels.size > 0 else 0.1,
        }
            
        if not valid_pixels.size > 0: return jsonify({"error": "Simulation resulted in no flooding."}), 422
        
        return jsonify({ 
            "status": "success", 
            "cache_filename": cache_filename,
            "end_raster_id": cache_filename,
            "stats": stats 
        })
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": f"An error occurred: {str(e)}"}), 500


def get_river_geometry(target_crs):
    search_terms = ['stream', 'river']; river_path = None
    for term in search_terms:
        found = glob.glob(os.path.join(VECTOR_DATA_PATH, f'**/*{term}*.shp'), recursive=True)
        if found: river_path = found[0]; break
    if not river_path: return None
    try:
        gdf = gpd.read_file(river_path)
        gdf = gdf[gdf.is_valid & ~gdf.is_empty]
        return unary_union(gdf.to_crs(target_crs).geometry) if not gdf.empty else None
    except Exception as e:
        print(f"Error processing river file {river_path}: {e}"); return None

@app.route('/api/precalculated_flood_zones')
def get_precalculated_flood_zones():
    geojson_path = os.path.join(GENERIC_DATA_PATH, 'flood_data.geojson')
    if not os.path.exists(geojson_path):
        with open(geojson_path, 'w') as f: json.dump({"type": "FeatureCollection", "features": []}, f)
    with open(geojson_path, 'r') as f: return jsonify(json.load(f))

@app.route('/api/get_live_rainfall')
def get_live_rainfall():
    lat = request.args.get('lat', type=float); lon = request.args.get('lon', type=float)
    if lat is None or lon is None: return jsonify({"error": "Latitude and Longitude are required."}), 400
    try:
        response = requests.get("https://api.open-meteo.com/v1/forecast", params={"latitude": lat, "longitude": lon, "current": "precipitation"}, timeout=10)
        response.raise_for_status()
        return jsonify({"success": True, "current_precipitation_mmhr": float(response.json().get('current', {}).get('precipitation', 0.0))})
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Could not fetch weather data: {e}"}), 502

@app.route('/solar_dashboard')
def solar_dashboard_page(): return render_template('solar-dashboard.html')

@app.route('/api/solar_irradiance', methods=['GET'])
def get_solar_irradiance_data():
    lat = float(request.args.get('lat', 10.3833)); lon = float(request.args.get('lon', 78.8333))
    api_key = os.environ.get("OPENWEATHER_API_KEY")
    if not api_key: return jsonify({"error": "OpenWeather API key not configured."}), 500
    try:
        one_call_url = f"https://api.openweathermap.org/data/3.0/onecall?lat={lat}&lon={lon}&exclude=minutely,daily,alerts&units=metric&appid={api_key}"
        response = requests.get(one_call_url); response.raise_for_status(); weather_data = response.json()
        hourly_data = weather_data['hourly']; tz = weather_data['timezone']
        times = pd.to_datetime([h['dt'] for h in hourly_data], unit='s').tz_localize('UTC').tz_convert(tz)
        df = pd.DataFrame({'temp_air': [h['temp'] for h in hourly_data], 'pressure': [h['pressure'] * 100 for h in hourly_data], 'dew_point': [h.get('dew_point', h['temp'] - 5) for h in hourly_data], 'clouds': [h['clouds'] for h in hourly_data],}, index=times)
        solpos = pvlib.solarposition.get_solarposition(times, lat, lon)
        clear_sky = pvlib.clearsky.simplified_solis(apparent_zenith=solpos['apparent_zenith'], aod700=0.1, precipitable_water=pvlib.atmosphere.gueymard94_pw(df['temp_air'], df['dew_point']), pressure=df['pressure'], dni_extra=pvlib.irradiance.get_extra_radiation(times))
        clear_sky.rename(columns={'dni': 'dni_clear', 'ghi': 'ghi_clear', 'dhi': 'dhi_clear'}, inplace=True)
        cloudy_sky = pvlib.cloudcover.dirint(ghi=clear_sky['ghi_clear'], solar_zenith=solpos['apparent_zenith'], temp_dew=df['dew_point'], pressure=df['pressure'])
        cloudy_sky['dhi_cloudy'] = clear_sky['dhi_clear']
        cloudy_sky['ghi_cloudy'] = cloudy_sky['dni'] * np.cos(np.radians(solpos['apparent_zenith'])) + cloudy_sky['dhi_cloudy']
        cloudy_sky.rename(columns={'dni': 'dni_cloudy'}, inplace=True)
        final_df = pd.concat([clear_sky, cloudy_sky], axis=1); final_df[final_df < 0] = 0
        return jsonify(json.loads(final_df.to_json(orient='table', date_format='iso'))['data'])
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": f"Solar calculation error: {str(e)}"}), 500

@app.route('/upload-model', methods=['POST'])
def upload_model():
    if 'files' not in request.files: return jsonify({'success': False, 'message': 'No file part'}), 400
    files = request.files.getlist('files')
    if not files or files[0].filename == '': return jsonify({'success': False, 'message': 'No files selected'}), 400
    model_id = str(uuid.uuid4()); model_upload_path = os.path.join(app.config['UPLOAD_FOLDER'], model_id)
    os.makedirs(model_upload_path)
    try:
        for file in files:
            if file: file.save(os.path.join(model_upload_path, secure_filename(file.filename)))
        return jsonify({'success': True, 'modelId': model_id, 'message': 'Files uploaded.'})
    except Exception as e:
        traceback.print_exc(); return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/inspector/<model_id>')
def inspector(model_id):
    model_dir = os.path.join(app.config['UPLOAD_FOLDER'], model_id)
    if not os.path.isdir(model_dir): abort(404, "Model not found")
    obj_filename = next((f for f in os.listdir(model_dir) if f.lower().endswith('.obj')), None)
    mtl_filename = next((f for f in os.listdir(model_dir) if f.lower().endswith('.mtl')), None)
    if not obj_filename: return "No .obj file found.", 404
    return render_template('obj.html', model_id=model_id, model_obj_path=f"/static/uploads/{model_id}/{obj_filename}", model_mtl_path=f"/static/uploads/{model_id}/{mtl_filename}" if mtl_filename else "")

@app.route('/api/elevation_layers')
def list_elevation_layers():
    if not os.path.isdir(ELEVATION_DATA_PATH): return jsonify([])
    layers = []
    for fname in sorted(os.listdir(ELEVATION_DATA_PATH)):
        if fname.lower().endswith(('.tif', '.tiff')):
            try:
                with rasterio.open(os.path.join(ELEVATION_DATA_PATH, fname)) as src:
                    stats = src.statistics(1)
                    layers.append({"id": fname, "name": os.path.splitext(fname)[0].replace('_', ' ').title(), "stats": {'min': stats.min, 'max': stats.max}})
            except Exception as e: print(f"Error processing DEM {fname}: {e}")
    return jsonify(layers)

@app.route('/api/vector_layers')
def list_vector_layers():
    if not os.path.isdir(VECTOR_DATA_PATH): return jsonify([])
    files = glob.glob(os.path.join(VECTOR_DATA_PATH, '**', '*.shp'), recursive=True) + glob.glob(os.path.join(VECTOR_DATA_PATH, '**', '*.zip'), recursive=True)
    return jsonify(sorted([{"id": os.path.basename(f), "name": os.path.splitext(os.path.basename(f))[0].replace('_', ' ').replace('-', ' ').title()} for f in files], key=lambda x: x['name']))

@app.route('/api/raster_layers')
def list_raster_layers():
    if not os.path.isdir(RASTER_DATA_PATH): return jsonify([])
    layers = []
    for fname in sorted(os.listdir(RASTER_DATA_PATH)):
        if fname.lower().endswith(('.tif', '.tiff')):
            try:
                with rasterio.open(os.path.join(RASTER_DATA_PATH, fname)) as src:
                    stats = []
                    for i in range(1, src.count + 1):
                        band = src.read(i, masked=True)
                        min_val, max_val = (np.percentile(band[~band.mask], [2, 98])) if band.count() > 0 else (0, 0)
                        stats.append({'min': float(min_val), 'max': float(max_val)})
                    layers.append({"id": fname, "name": os.path.splitext(fname)[0].replace('_', ' ').title(), "bands": src.count, "stats": stats})
            except Exception as e: print(f"Could not process raster {fname}: {e}")
    return jsonify(layers)

@app.route('/api/pointcloud_layers')
def list_pointcloud_layers():
    if not os.path.isdir(POINTCLOUD_DATA_PATH): return jsonify([])
    all_files = []
    for pattern in ['*.las', '*.laz']:
        all_files.extend(glob.glob(os.path.join(POINTCLOUD_DATA_PATH, pattern)))
    return jsonify([{"id": os.path.basename(f), "name": os.path.splitext(os.path.basename(f))[0]} for f in sorted(all_files)])

def preprocess_point_cloud(filename):
    pc_path = os.path.join(POINTCLOUD_DATA_PATH, filename)
    base_name = os.path.splitext(filename)[0]
    meta_path = os.path.join(CACHE_PATH, f"{base_name}.json")

    if os.path.exists(meta_path):
        with open(meta_path, 'r') as f:
            return json.load(f)

    print(f"Pre-processing {filename} for the first time...")
    
    try:
        pipeline_json = [{"type": "readers.las", "filename": pc_path}]
        pipeline = pdal.Pipeline(json.dumps(pipeline_json))
        
        count = pipeline.execute()
        if count == 0:
            raise RuntimeError("PDAL returned no points from the file. It may be empty or invalid.")
            
        points = pipeline.arrays[0]
        
        bbox_raw = {
            "minx": float(np.min(points['X'])), "maxx": float(np.max(points['X'])),
            "miny": float(np.min(points['Y'])), "maxy": float(np.max(points['Y'])),
            "minz": float(np.min(points['Z'])), "maxz": float(np.max(points['Z'])),
        }
        
        center_x = (bbox_raw['maxx'] + bbox_raw['minx']) / 2
        center_y = (bbox_raw['maxy'] + bbox_raw['miny']) / 2
        center_z = (bbox_raw['maxz'] + bbox_raw['minz']) / 2

        positions = np.vstack((points['X'] - center_x, points['Y'] - center_y, points['Z'] - center_z)).astype(np.float32).T
        positions.tofile(os.path.join(CACHE_PATH, f"{base_name}_positions.bin"))

        color_attributes = []
        classification_available = False

        if 'Red' in points.dtype.names:
            rgb = np.vstack((points['Red']/65535, points['Green']/65535, points['Blue']/65535)).astype(np.float32).T
            rgb.tofile(os.path.join(CACHE_PATH, f"{base_name}_color_rgb.bin"))
            color_attributes.append('rgb')

        if 'Classification' in points.dtype.names:
            classification_available = True
            class_colors_map = { 1: (200, 200, 200), 2: (165, 80, 40), 3: (0, 255, 0), 4: (0, 150, 0), 5: (0, 100, 0), 6: (255, 0, 0), 9: (0, 0, 255) }
            default_color = (200, 200, 200)
            classification_color = (np.array([class_colors_map.get(c, default_color) for c in points['Classification']]) / 255.0).astype(np.float32)
            classification_color.tofile(os.path.join(CACHE_PATH, f"{base_name}_color_classification.bin"))
            color_attributes.append('classification')
            
            # --- NEW: Save the raw classification values for filtering ---
            classification_raw = points['Classification'].astype(np.uint8)
            classification_raw.tofile(os.path.join(CACHE_PATH, f"{base_name}_classification_raw.bin"))
        
        z_values = points['Z']
        norm = Normalize(vmin=z_values.min(), vmax=z_values.max())
        cmap = plt.get_cmap('viridis')
        elevation = cmap(norm(z_values))[:, :3].astype(np.float32)
        elevation.tofile(os.path.join(CACHE_PATH, f"{base_name}_color_elevation.bin"))
        color_attributes.append('elevation')
        
        final_meta = {
            "point_count": count,
            "bbox": {
                "min": [bbox_raw['minx'], bbox_raw['miny'], bbox_raw['minz']],
                "max": [bbox_raw['maxx'], bbox_raw['maxy'], bbox_raw['maxz']],
            },
            "color_attributes": color_attributes,
            "classification_available": classification_available,
            "files": {
                "positions": f"{base_name}_positions.bin",
                "colors": {attr: f"{base_name}_color_{attr}.bin" for attr in color_attributes},
                "classification_raw": f"{base_name}_classification_raw.bin" if classification_available else None
            }
        }
        with open(meta_path, 'w') as f:
            json.dump(final_meta, f)
            
        return final_meta

    except Exception as e:
        traceback.print_exc()
        raise RuntimeError(f"Failed during pre-processing: {str(e)}")


@app.route('/api/get_pointcloud_metadata/<path:filename>')
def get_pointcloud_metadata(filename):
    try:
        metadata = preprocess_point_cloud(filename)
        return jsonify(metadata)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/get_pointcloud_data/<path:filename>')
def get_pointcloud_binary_data(filename):
    if not os.path.exists(os.path.join(CACHE_PATH, filename)):
        abort(404, "Pre-processed data file not found.")
    return send_from_directory(CACHE_PATH, filename)

@app.route('/api/layer_bounds/<layer_type>/<path:layer_filename>')
def get_layer_bounds(layer_type, layer_filename):
    try:
        path = None; source_path_map = {'dem': ELEVATION_DATA_PATH, 'raster': RASTER_DATA_PATH, 'pointcloud': POINTCLOUD_DATA_PATH}
        if layer_type in source_path_map: path = os.path.join(source_path_map[layer_type], layer_filename)
        if layer_type == 'raster' and not os.path.exists(path): path = os.path.join(CACHE_PATH, layer_filename)
        elif layer_type == 'vector':
            files = glob.glob(os.path.join(VECTOR_DATA_PATH, '**', layer_filename), recursive=True)
            if not files: return jsonify({"error": "Vector file not found"}), 404
            gdf = gpd.read_file(f"zip://{files[0]}" if files[0].lower().endswith('.zip') else files[0])
            return jsonify({"bounds": list(gdf.to_crs("EPSG:4326").total_bounds)})
        elif layer_type == 'pointcloud' and pdal:
            if not path or not os.path.exists(path):
                return jsonify({"error": "Point cloud file not found on server"}), 404
            try:
                info = pdal.Pipeline(json.dumps([{"type":"readers.las","filename":path}])).quickinfo['readers.las']
                b = info['bounds']
                bounds = gpd.GeoDataFrame(geometry=[box(b['minx'],b['miny'],b['maxx'],b['maxy'])], crs=info['srs']['wkt']).to_crs("EPSG:4326").total_bounds
                return jsonify({"bounds": list(bounds)})
            except Exception as pdal_error:
                error_message = f"PDAL failed to read '{layer_filename}'. The file may be corrupt or in an unsupported format. PDAL error: {str(pdal_error)}"
                print(f"ERROR: {error_message}")
                traceback.print_exc()
                return jsonify({"error": error_message}), 500
        if path and os.path.exists(path):
            with rasterio.open(path) as src: return jsonify({"bounds": list(transform_bounds(src.crs, "EPSG:4326", *src.bounds))})
        return jsonify({"error": "File not found or layer type is invalid"}), 404
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500


@app.route('/api/vector_layer/<string:layer_filename>')
def serve_vector_layer(layer_filename):
    try:
        files = glob.glob(os.path.join(VECTOR_DATA_PATH, '**', layer_filename), recursive=True)
        if not files: return jsonify({"error": f"Vector file not found: {layer_filename}"}), 404
        gdf = gpd.read_file(f"zip://{files[0]}" if files[0].lower().endswith('.zip') else files[0])
        for col in gdf.select_dtypes(include=['object']).columns: gdf[col] = gdf[col].fillna("")
        if 'builtup' in layer_filename.lower():
            h_field = next((f for f in ["height", "Height", "HEIGHT", "relh", "building_h", "LOD"] if f in gdf.columns), None)
            if h_field: gdf[h_field] = pd.to_numeric(gdf[h_field], errors='coerce').fillna(10.0)
        return jsonify(json.loads(gdf.to_crs(epsg=4326).to_json()))
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500

@app.route('/api/raster_tile/<path:layer_filename>/<int:z>/<int:x>/<int:y>.png')
def serve_raster_overlay_tile(layer_filename, z, x, y):
    path = os.path.join(CACHE_PATH, layer_filename)
    if not os.path.exists(path): path = os.path.join(RASTER_DATA_PATH, layer_filename)
    if not os.path.exists(path): return "File not found", 404
    try:
        with rasterio.open(path) as src:
            merc_b = mercantile.xy_bounds(x, y, z); dst_tf = rasterio.transform.from_bounds(*merc_b, width=256, height=256); nodata = src.nodata if src.nodata is not None else -9999
            if 'r' in request.args:
                p_mins = [float(v) for v in request.args.get('p_mins', '0,0,0').split(',')]; p_maxs = [float(v) for v in request.args.get('p_maxs', '1,1,1').split(',')]
                bands = [int(request.args.get('r')), int(request.args.get('g')), int(request.args.get('b'))]; rgb = np.zeros((3, 256, 256), dtype=np.uint8)
                for i in range(3):
                    band_data = np.full((256, 256), nodata, dtype=np.float32)
                    reproject(source=rasterio.band(src, bands[i]), destination=band_data, src_transform=src.transform, src_crs=src.crs, src_nodata=nodata, dst_transform=dst_tf, dst_crs='EPSG:3857', dst_nodata=nodata, resampling=Resampling.bilinear)
                    band_data = np.clip(((band_data - p_mins[i]) / (p_maxs[i] - p_mins[i] + 1e-9)) * 255, 0, 255).astype(np.uint8)
                    rgb[i] = band_data
                img = Image.fromarray(np.moveaxis(rgb, 0, -1), 'RGB')
            else:
                vmin = float(request.args.get('min', 0)); vmax = float(request.args.get('max', 1)); cmap_name = request.args.get('colormap', 'Spectral_r')
                arr = np.full((256, 256), nodata, dtype=np.float32)
                reproject(source=rasterio.band(src, 1), destination=arr, src_transform=src.transform, src_crs=src.crs, src_nodata=nodata, dst_transform=dst_tf, dst_crs='EPSG:3857', dst_nodata=nodata, resampling=Resampling.bilinear)
                mask = (arr == nodata) | ~np.isfinite(arr); norm = Normalize(vmin=vmin, vmax=vmax, clip=True)
                if cmap_name == 'flood_custom':
                    bp_norm = min(1.0, max(0.0, (0.5 - vmin) / (vmax - vmin))) if vmax > vmin else 0.5
                    cmap = LinearSegmentedColormap.from_list("custom_flood_cmap", [(0.0, "#a6cee3"), (bp_norm, "#a6cee3"), (1.0, "#1f78b4")])
                elif cmap_name == 'slope': cmap = LinearSegmentedColormap.from_list("slope_cmap", ["#2ca25f", "#ffffbf", "#fee08b", "#fdae61", "#f46d43", "#d73027", "#a50026"])
                elif cmap_name == 'ocean': cmap = cm.get_cmap('ocean')
                else: cmap = cm.get_cmap(cmap_name)
                rgba = (cmap(norm(arr)) * 255).astype(np.uint8); rgba[mask] = [0, 0, 0, 0]; img = Image.fromarray(rgba, 'RGBA')
            buf = io.BytesIO(); img.save(buf, 'PNG'); buf.seek(0)
            return Response(buf.getvalue(), mimetype='image/png')
    except Exception as e:
        traceback.print_exc(); img = Image.new('RGBA', (256, 256), (0,0,0,0)); buf = io.BytesIO(); img.save(buf, 'PNG'); buf.seek(0)
        return Response(buf.getvalue(), mimetype='image/png')

@app.route('/api/layer_bounds_polygon/<path:dem_id>')
def get_layer_bounds_polygon(dem_id):
    path = os.path.join(ELEVATION_DATA_PATH, dem_id)
    if not os.path.exists(path): return jsonify({"error": "DEM not found"}), 404
    try:
        with rasterio.open(path) as src: b = src.bounds; geom = box(b.left, b.bottom, b.right, b.top)
        return jsonify(json.loads(gpd.GeoDataFrame([1], geometry=[geom], crs=src.crs).to_crs(epsg=4326).to_json()))
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500

@app.route('/api/dem_tile/<path:filename>/<int:z>/<int:x>/<int:y>.png')
def dem_tile_server(filename, z, x, y):
    path = os.path.join(CACHE_PATH, filename)
    if not os.path.exists(path): path = os.path.join(ELEVATION_DATA_PATH, filename)
    if not os.path.exists(path): return "Not Found", 404
    try:
        with rasterio.open(path) as src:
            merc_b = mercantile.xy_bounds(x,y,z); dst_tf = rasterio.transform.from_bounds(*merc_b, width=256, height=256); nodata = src.nodata if src.nodata is not None else -9999
            tile = np.full((256, 256), nodata, dtype=np.float32)
            reproject(source=rasterio.band(src, 1), destination=tile, src_transform=src.transform, src_crs=src.crs, src_nodata=nodata, dst_transform=dst_tf, dst_crs='EPSG:3857', dst_nodata=nodata, resampling=Resampling.bilinear)
            img = Image.fromarray(encode_terrain_rgb(tile, nodata), 'RGB'); buf = io.BytesIO(); img.save(buf, 'PNG'); buf.seek(0)
            return Response(buf.getvalue(), mimetype='image/png')
    except Exception as e:
        print(f"DEM tile error for {filename}: {e}"); img = Image.new('RGBA', (256,256), (0,0,0,0)); buf = io.BytesIO(); img.save(buf, 'PNG'); buf.seek(0)
        return Response(buf.getvalue(), mimetype='image/png')

@app.route('/api/generate_profile', methods=['POST'])
def generate_profile():
    data = request.get_json(); dem_filename = data.get('dem_filename'); line_coords = data.get('line')
    if not dem_filename or not line_coords or len(line_coords) < 2: return jsonify({"error": "Invalid request."}), 400
    dem_path = os.path.join(ELEVATION_DATA_PATH, dem_filename)
    if not os.path.exists(dem_path): return jsonify({"error": "DEM file not found."}), 404
    try:
        with rasterio.open(dem_path) as src:
            to_dem_crs = pyproj.Transformer.from_crs('EPSG:4326', src.crs, always_xy=True); to_wgs84 = pyproj.Transformer.from_crs(src.crs, 'EPSG:4326', always_xy=True)
            profile_data = []
            for i in range(len(line_coords) - 1):
                start_x, start_y = to_dem_crs.transform(line_coords[i][0], line_coords[i][1]); end_x, end_y = to_dem_crs.transform(line_coords[i+1][0], line_coords[i+1][1])
                x_s, y_s = np.linspace(start_x, end_x, 100), np.linspace(start_y, end_y, 100)
                elevs = [val[0] for val in src.sample(list(zip(x_s, y_s)))]
                wgs84_coords = [to_wgs84.transform(x, y) for x, y in list(zip(x_s, y_s))]
                for j in range(100):
                    if j == 99 and i < len(line_coords) - 2: continue
                    elev = float(elevs[j]) if elevs[j] is not None and elevs[j] != src.nodata else None
                    profile_data.append({'lon': wgs84_coords[j][0], 'lat': wgs84_coords[j][1], 'elev': elev})
        return jsonify({"profile_data": profile_data})
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500

@app.route('/api/calculate_slope', methods=['POST'])
def calculate_slope():
    data = request.get_json()
    if not data or 'dem_filename' not in data: return jsonify({"error": "DEM filename required."}), 400
    dem_path = os.path.join(ELEVATION_DATA_PATH, data['dem_filename'])
    if not os.path.exists(dem_path): return jsonify({"error": "DEM not found."}), 404
    try:
        dem = rd.LoadGDAL(dem_path); slope = rd.TerrainAttribute(dem, attrib='slope_degrees'); valid = slope[dem != dem.no_data]
        min_val, max_val = (np.percentile(valid, [2, 98])) if valid.size > 0 else (0, 45)
        if min_val >= max_val: max_val = min_val + 1.0
        cache_filename = f"slope_{os.path.splitext(data['dem_filename'])[0]}.tif"
        rd.SaveGDAL(os.path.join(CACHE_PATH, cache_filename), slope)
        return jsonify({"status": "success", "cache_filename": cache_filename, "stats": {"min": float(min_val), "max": float(max_val)}})
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500

@app.route('/api/calculate_aspect', methods=['POST'])
def calculate_aspect():
    data = request.get_json()
    if not data or 'dem_filename' not in data: return jsonify({"error": "DEM filename required."}), 400
    dem_path = os.path.join(ELEVATION_DATA_PATH, data['dem_filename'])
    if not os.path.exists(dem_path): return jsonify({"error": "DEM not found."}), 404
    try:
        dem = rd.LoadGDAL(dem_path); aspect = rd.TerrainAttribute(dem, attrib='aspect')
        cache_filename = f"aspect_{os.path.splitext(data['dem_filename'])[0]}.tif"
        rd.SaveGDAL(os.path.join(CACHE_PATH, cache_filename), aspect)
        return jsonify({"status": "success", "cache_filename": cache_filename, "stats": {"min": 0, "max": 360}})
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500

@app.route('/api/landslide_hazard', methods=['POST'])
def landslide_hazard_analysis():
    data = request.get_json(); dem_filename = data.get('dem_filename'); rainfall_mm = float(data.get('rainfall_mm', 50.0))
    if not dem_filename: return jsonify({"error": "DEM filename required."}), 400
    dem_path = os.path.join(ELEVATION_DATA_PATH, dem_filename)
    if not os.path.exists(dem_path): return jsonify({"error": "DEM not found."}), 404
    try:
        dem = rd.LoadGDAL(dem_path, no_data=-9999); slope = rd.TerrainAttribute(dem, attrib='slope_degrees')
        hazard = (0.5 * np.clip(slope / 90, 0, 1)) + (0.5 * np.clip(rainfall_mm / 150.0, 0, 1))
        hazard[dem == -9999] = -9999; valid = hazard[hazard != -9999]
        min_val, max_val = (np.percentile(valid, [2, 98])) if valid.size > 0 else (0, 1)
        if max_val <= min_val: max_val = min_val + 0.1
        cache_filename = f"hazard_{os.path.splitext(dem_filename)[0]}_{int(rainfall_mm)}mm.tif"
        rd.SaveGDAL(os.path.join(CACHE_PATH, cache_filename), hazard)
        return jsonify({"status": "success", "cache_filename": cache_filename, "stats": {"min": float(min_val), "max": float(max_val)}})
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": str(e)}), 500

@app.route('/api/query_elevation', methods=['POST'])
def query_elevation():
    data = request.get_json()
    if not data or 'dem_filename' not in data or 'lon' not in data or 'lat' not in data: return "Invalid request", 400
    path = os.path.join(ELEVATION_DATA_PATH, data['dem_filename'])
    if not os.path.exists(path): return {"error": "DEM file not found"}, 404
    try:
        with rasterio.open(path) as src:
            transformer = pyproj.Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
            dem_x, dem_y = transformer.transform(data['lon'], data['lat'])
            elev = next(src.sample([(dem_x, dem_y)]))[0]
            elev = float(elev) if elev != src.nodata else None
            return jsonify({"elevation": elev, "lon": data['lon'], "lat": data['lat']})
    except Exception as e:
        traceback.print_exc(); return jsonify({"error": "Failed to process elevation"}), 500

@app.route('/api/stream_layer')
def get_stream_layer():
    for term in ['stream', 'river']:
        files = glob.glob(os.path.join(VECTOR_DATA_PATH, f'**/*{term}*.shp'), recursive=True) + glob.glob(os.path.join(VECTOR_DATA_PATH, f'**/*{term}*.zip'), recursive=True)
        if files:
            try:
                gdf = gpd.read_file(f"zip://{files[0]}" if files[0].lower().endswith('.zip') else files[0])
                return jsonify(json.loads(gdf[gdf.is_valid].to_crs("EPSG:4326").to_json()))
            except Exception as e:
                return jsonify({"error": f"Error reading stream file: {str(e)}"}), 500
    return jsonify({"error": "No stream or river shapefile found."}), 404

if __name__ == "__main__":

    app.run()

