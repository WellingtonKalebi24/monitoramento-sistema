# Modelos faciais locais

Este diretório recebe os modelos locais utilizados pelo serviço de IA:

- `face_detection_yunet_2023mar.onnx` — detecção facial YuNet;
- `face_recognition_sface_2021dec.onnx` — embeddings faciais SFace.

Para baixá-los:

```powershell
.\.venv\Scripts\python.exe apps\ai\download_models.py
```

Os modelos são processados localmente e não dependem de API paga.
O instalador usa uma distribuição pública dos mesmos modelos e somente aceita
os arquivos quando os hashes SHA-256 coincidem com os binários do OpenCV Zoo.
Antes de distribuir comercialmente o produto, mantenha junto à distribuição
os avisos/licenças correspondentes aos modelos e ao OpenCV.
