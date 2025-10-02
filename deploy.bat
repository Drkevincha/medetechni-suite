@echo off
echo ===============================
echo 🚀 Construyendo e implementando MedETechni Suite
echo ===============================

REM Ir al directorio del script
cd /d %~dp0

echo 🔨 Subiendo a Cloud Build...
gcloud builds submit --tag gcr.io/medetechni-clinica/medetechni-suite .

echo 🚀 Desplegando en Cloud Run...
gcloud run deploy medetechni-suite ^
  --image gcr.io/medetechni-clinica/medetechni-suite ^
  --platform managed ^
  --region us-central1 ^
  --allow-unauthenticated ^
  --project=medetechni-clinica

echo ===============================
echo ✅ Despliegue completado
echo ===============================
pause
