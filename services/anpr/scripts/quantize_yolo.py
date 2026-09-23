"""
Script de Cuantización de Modelos YOLO para Optimización de Inferencia

Este script implementa la cuantización de modelos YOLO para mejorar el rendimiento
de inferencia en producción, especialmente útil para despliegues en CPU o hardware
con recursos limitados.

Tipos de cuantización soportados:
1. INT8 Cuantización: Mayor compresión, más rápido, ligera pérdida de precisión
2. FP16 Cuantización: Balance entre precisión y rendimiento
3. Dynamic Quantization: Cuantización dinámica durante la inferencia

Beneficios esperados:
- Reducción del tamaño del modelo: 2-4x más pequeño
- Aceleración de inferencia: 1.5-3x más rápido en CPU
- Menor consumo de memoria
"""

import os
import argparse
from pathlib import Path
from ultralytics import YOLO
import torch
import logging

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def check_hardware_support():
    """Verifica el soporte de hardware para diferentes tipos de cuantización."""
    logger.info("Verificando soporte de hardware...")
    
    # Verificar si CUDA está disponible
    cuda_available = torch.cuda.is_available()
    logger.info(f"CUDA disponible: {cuda_available}")
    
    if cuda_available:
        logger.info(f"Dispositivo CUDA: {torch.cuda.get_device_name(0)}")
        logger.info(f"Capacidad de cómputo: {torch.cuda.get_device_capability(0)}")
    
    # Verificar soporte para cuantización INT8
    int8_supported = hasattr(torch, 'quantization') and cuda_available
    logger.info(f"INT8 Cuantización soportada: {int8_supported}")
    
    return {
        'cuda': cuda_available,
        'int8': int8_supported
    }


def quantize_model_int8(model_path: str, output_path: str, sample_data_path: str = None):
    """
    Aplica cuantización INT8 estática al modelo YOLO.
    
    Args:
        model_path: Ruta al modelo original (.pt)
        output_path: Ruta donde guardar el modelo cuantizado
        sample_data_path: Ruta a datos de muestra para calibración (opcional)
    """
    logger.info(f"Iniciando cuantización INT8 de {model_path}")
    
    try:
        # Cargar modelo original
        model = YOLO(model_path)
        logger.info(f"Modelo original cargado: {model_path}")
        
        # Exportar a ONNX primero (requisito para cuantización INT8)
        onnx_path = model_path.replace('.pt', '.onnx')
        logger.info(f"Exportando a ONNX: {onnx_path}")
        
        # Exportar a ONNX
        model.export(
            format='onnx',
            dynamic=True,
            simplify=True,
            opset=12
        )
        
        logger.info(f"Modelo ONNX exportado: {onnx_path}")
        
        # Cuantizar ONNX a INT8
        logger.info("Aplicando cuantización INT8...")
        
        try:
            import onnx
            from onnxruntime.quantization import quantize_dynamic, QuantType
            
            # Cargar modelo ONNX
            onnx_model = onnx.load(onnx_path)
            
            # Aplicar cuantización dinámica INT8
            quantized_model = quantize_dynamic(
                onnx_model,
                model_type=QuantType.QInt8,
                weight_type=QuantType.QInt8,
                optimize_model=True
            )
            
            # Guardar modelo cuantizado
            quantized_path = output_path.replace('.pt', '_int8.onnx')
            onnx.save(quantized_model, quantized_path)
            
            logger.info(f"Modelo INT8 cuantizado guardado: {quantized_path}")
            
            # Comparar tamaños
            original_size = os.path.getsize(model_path) / (1024 * 1024)
            quantized_size = os.path.getsize(quantized_path) / (1024 * 1024)
            reduction = (1 - quantized_size / original_size) * 100
            
            logger.info(f"Tamaño original: {original_size:.2f} MB")
            logger.info(f"Tamaño cuantizado: {quantized_size:.2f} MB")
            logger.info(f"Reducción de tamaño: {reduction:.1f}%")
            
            return quantized_path
            
        except ImportError:
            logger.warning("onnxruntime no disponible, intentando cuantización PyTorch...")
            
            # Cuantización PyTorch (alternativa)
            import torch.ao.quantization as quantization
            
            # Configurar cuantización
            model.model.float()
            
            # Aplicar cuantización dinámica
            quantized_model = torch.quantization.quantize_dynamic(
                model.model,
                {torch.nn.Linear, torch.nn.Conv2d},
                dtype=torch.qint8
            )
            
            # Guardar modelo cuantizado
            quantized_path = output_path.replace('.pt', '_int8.pt')
            torch.save(quantized_model.state_dict(), quantized_path)
            
            logger.info(f"Modelo INT8 cuantizado guardado: {quantized_path}")
            return quantized_path
            
    except Exception as e:
        logger.error(f"Error en cuantización INT8: {e}")
        raise


def quantize_model_fp16(model_path: str, output_path: str):
    """
    Aplica cuantización FP16 (half precision) al modelo YOLO.
    
    Args:
        model_path: Ruta al modelo original (.pt)
        output_path: Ruta donde guardar el modelo cuantizado
    """
    logger.info(f"Iniciando cuantización FP16 de {model_path}")
    
    try:
        # Cargar modelo original
        model = YOLO(model_path)
        logger.info(f"Modelo original cargado: {model_path}")
        
        # Convertir a FP16
        model.model.half()
        
        # Guardar modelo FP16
        quantized_path = output_path.replace('.pt', '_fp16.pt')
        model.save(quantized_path)
        
        logger.info(f"Modelo FP16 cuantizado guardado: {quantized_path}")
        
        # Comparar tamaños
        original_size = os.path.getsize(model_path) / (1024 * 1024)
        quantized_size = os.path.getsize(quantized_path) / (1024 * 1024)
        reduction = (1 - quantized_size / original_size) * 100
        
        logger.info(f"Tamaño original: {original_size:.2f} MB")
        logger.info(f"Tamaño cuantizado: {quantized_size:.2f} MB")
        logger.info(f"Reducción de tamaño: {reduction:.1f}%")
        
        return quantized_path
        
    except Exception as e:
        logger.error(f"Error en cuantización FP16: {e}")
        raise


def export_to_tensorrt(model_path: str, output_path: str):
    """
    Exporta modelo YOLO a TensorRT para máxima optimización en NVIDIA GPUs.
    
    Args:
        model_path: Ruta al modelo original (.pt)
        output_path: Ruta donde guardar el modelo TensorRT
    """
    logger.info(f"Iniciando exportación a TensorRT de {model_path}")
    
    try:
        if not torch.cuda.is_available():
            logger.error("TensorRT requiere CUDA. CUDA no está disponible.")
            return None
        
        # Cargar modelo
        model = YOLO(model_path)
        
        # Exportar a TensorRT
        trt_path = model.export(
            format='engine',
            dynamic=True,
            simplify=True,
            workspace=4  # GB de memoria para optimización
        )
        
        logger.info(f"Modelo TensorRT exportado: {trt_path}")
        
        # Comparar tamaños
        original_size = os.path.getsize(model_path) / (1024 * 1024)
        trt_size = os.path.getsize(trt_path) / (1024 * 1024)
        
        logger.info(f"Tamaño original: {original_size:.2f} MB")
        logger.info(f"Tamaño TensorRT: {trt_size:.2f} MB")
        
        return trt_path
        
    except Exception as e:
        logger.error(f"Error en exportación TensorRT: {e}")
        raise


def benchmark_models(original_path: str, quantized_path: str, num_iterations: int = 100):
    """
    Compara el rendimiento de los modelos original y cuantizado.
    
    Args:
        original_path: Ruta al modelo original
        quantized_path: Ruta al modelo cuantizado
        num_iterations: Número de iteraciones para benchmark
    """
    logger.info(f"Ejecutando benchmark con {num_iterations} iteraciones...")
    
    import time
    import numpy as np
    
    # Crear imagen de prueba
    test_image = np.random.randint(0, 255, (640, 640, 3), dtype=np.uint8)
    
    # Benchmark modelo original
    logger.info("Benchmark modelo original...")
    original_model = YOLO(original_path)
    
    original_times = []
    for i in range(num_iterations):
        start = time.time()
        _ = original_model(test_image, verbose=False)
        original_times.append(time.time() - start)
    
    original_avg = np.mean(original_times) * 1000  # ms
    original_std = np.std(original_times) * 1000
    
    # Benchmark modelo cuantizado
    logger.info("Benchmark modelo cuantizado...")
    quantized_model = YOLO(quantized_path)
    
    quantized_times = []
    for i in range(num_iterations):
        start = time.time()
        _ = quantized_model(test_image, verbose=False)
        quantized_times.append(time.time() - start)
    
    quantized_avg = np.mean(quantized_times) * 1000  # ms
    quantized_std = np.std(quantized_times) * 1000
    
    # Calcular speedup
    speedup = original_avg / quantized_avg
    
    logger.info("=" * 50)
    logger.info("RESULTADOS DEL BENCHMARK")
    logger.info("=" * 50)
    logger.info(f"Modelo Original:")
    logger.info(f"  Tiempo promedio: {original_avg:.2f} ± {original_std:.2f} ms")
    logger.info(f"  FPS: {1000/original_avg:.1f}")
    logger.info(f"Modelo Cuantizado:")
    logger.info(f"  Tiempo promedio: {quantized_avg:.2f} ± {quantized_std:.2f} ms")
    logger.info(f"  FPS: {1000/quantized_avg:.1f}")
    logger.info(f"Speedup: {speedup:.2f}x")
    logger.info("=" * 50)


def main():
    parser = argparse.ArgumentParser(description='Cuantización de modelos YOLO para ANPR')
    parser.add_argument('--model', type=str, required=True,
                       help='Ruta al modelo YOLO original (.pt)')
    parser.add_argument('--output', type=str, default='./models',
                       help='Directorio de salida para modelos cuantizados')
    parser.add_argument('--type', type=str, choices=['int8', 'fp16', 'tensorrt', 'all'],
                       default='all', help='Tipo de cuantización a aplicar')
    parser.add_argument('--benchmark', action='store_true',
                       help='Ejecutar benchmark comparativo')
    parser.add_argument('--iterations', type=int, default=100,
                       help='Número de iteraciones para benchmark')
    
    args = parser.parse_args()
    
    # Verificar que el modelo existe
    if not os.path.exists(args.model):
        logger.error(f"Modelo no encontrado: {args.model}")
        return
    
    # Crear directorio de salida
    os.makedirs(args.output, exist_ok=True)
    
    # Verificar soporte de hardware
    hw_support = check_hardware_support()
    
    # Nombre base del modelo
    model_name = Path(args.model).stem
    output_path = os.path.join(args.output, model_name + '_quantized.pt')
    
    quantized_paths = []
    
    # Aplicar cuantización según el tipo seleccionado
    if args.type in ['int8', 'all']:
        try:
            int8_path = quantize_model_int8(args.model, output_path)
            quantized_paths.append(('INT8', int8_path))
        except Exception as e:
            logger.error(f"Fallo en cuantización INT8: {e}")
    
    if args.type in ['fp16', 'all']:
        try:
            fp16_path = quantize_model_fp16(args.model, output_path)
            quantized_paths.append(('FP16', fp16_path))
        except Exception as e:
            logger.error(f"Fallo en cuantización FP16: {e}")
    
    if args.type in ['tensorrt', 'all'] and hw_support['cuda']:
        try:
            trt_path = export_to_tensorrt(args.model, output_path)
            if trt_path:
                quantized_paths.append(('TensorRT', trt_path))
        except Exception as e:
            logger.error(f"Fallo en exportación TensorRT: {e}")
    
    # Ejecutar benchmark si se solicita
    if args.benchmark and quantized_paths:
        for quant_type, quant_path in quantized_paths:
            logger.info(f"\nBenchmark: Original vs {quant_type}")
            benchmark_models(args.model, quant_path, args.iterations)
    
    logger.info("\nProceso de cuantización completado.")
    logger.info("Modelos cuantizados generados:")
    for quant_type, path in quantized_paths:
        logger.info(f"  {quant_type}: {path}")


if __name__ == '__main__':
    main()