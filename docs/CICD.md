# Guía de CI/CD para el Sistema ANPR

## Overview

Esta guía explica la implementación del pipeline de CI/CD automatizado para el sistema ANPR utilizando GitHub Actions.

## Arquitectura del Pipeline

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Git Push      │         │   CI Pipeline   │         │   CD Pipeline   │
│   (GitHub)      │         │   (Tests + Build)│         │   (Deploy)       │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                          │                          │
         │ trigger                  │ trigger                  │ trigger
         │─────────────────────────>│                          │
         │                          │                          │
         │                          │                          │
         │                          │<─────────────────────────│
         │                          │                          │
         │                          │ deploy                   │
         │                          │─────────────────────────>│
         │                          │                          │
         │                          │                          │
         │<─────────────────────────│<─────────────────────────│
         │                          │                          │
         │ success/failure          │ success/failure          │ success/failure
```

## Pipeline de CI (Continuous Integration)

### Trigger

El pipeline de CI se ejecuta automáticamente en:
- Push a branches `main` o `develop`
- Pull requests a `main` o `develop`

### Jobs

#### 1. Test Backend

**Objetivo**: Ejecutar pruebas del backend Node.js

**Pasos**:
1. Checkout del código
2. Setup de Node.js 20
3. Instalación de dependencias
4. Ejecución de linter
5. Ejecución de tests unitarios
6. Generación de coverage
7. Upload de coverage a Codecov

#### 2. Test ANPR Service

**Objetivo**: Ejecutar pruebas del microservicio Python

**Pasos**:
1. Checkout del código
2. Setup de Python 3.11
3. Instalación de dependencias
4. Ejecución de tests con pytest
5. Generación de coverage
6. Upload de coverage a Codecov

#### 3. Test Frontend

**Objetivo**: Compilar y validar el frontend React

**Pasos**:
1. Checkout del código
2. Setup de Node.js 20
3. Instalación de dependencias
4. Ejecución de linter
5. Build de producción
6. Upload de artefactos

#### 4. Security Scan

**Objetivo**: Escanear vulnerabilidades de seguridad

**Pasos**:
1. Checkout del código
2. Escaneo con Trivy
3. Upload de resultados a GitHub Security

#### 5. Docker Build

**Objetivo**: Construir imágenes Docker

**Pasos**:
1. Checkout del código
2. Setup de Docker Buildx
3. Login a Docker Hub
4. Build y push de imágenes
5. Caching de capas para builds rápidos

## Pipeline de CD (Continuous Deployment)

### Trigger

El pipeline de CD se ejecuta automáticamente en:
- Push a branch `main`
- Disparo manual (workflow_dispatch)

### Jobs

#### 1. Deploy to Staging

**Objetivo**: Desplegar a ambiente de staging

**Pasos**:
1. Checkout del código
2. Configuración de kubectl
3. Deploy a Kubernetes
4. Ejecución de migraciones de BD
5. Verificación del deployment
6. Ejecución de smoke tests

#### 2. Deploy to Production

**Objetivo**: Desplegar a ambiente de producción

**Pasos**:
1. Checkout del código
2. Configuración de kubectl
3. Creación de backup de BD
4. Deploy a Kubernetes
5. Ejecución de migraciones de BD
6. Verificación del deployment
7. Ejecución de smoke tests
8. Notificación de éxito/fallo

#### 3. Rollback Production

**Objetivo**: Rollback automático en caso de fallo

**Pasos**:
1. Checkout del código
2. Configuración de kubectl
3. Rollback de deployments
4. Restauración de backup de BD
5. Notificación de rollback

## Configuración de Secrets

### Secrets Requeridos

#### Docker Hub
```
DOCKER_USERNAME: usuario de Docker Hub
DOCKER_PASSWORD: password de Docker Hub
```

#### Kubernetes
```
KUBE_CONFIG_STAGING: configuración de kubeconfig para staging
KUBE_CONFIG_PRODUCTION: configuración de kubeconfig para producción
```

#### Slack (Opcional)
```
SLACK_WEBHOOK: webhook URL para notificaciones de Slack
```

### Configuración de Secrets en GitHub

1. Ir al repositorio en GitHub
2. Settings → Secrets and variables → Actions
3. New repository secret
4. Agregar cada secret requerido

## Comandos Locales

### Ejecutar Tests Localmente

```bash
# Backend
cd backend
npm test
npm run test:coverage

# ANPR Service
cd services/anpr
pytest tests/ -v --cov=app

# Frontend
cd frontend
npm run build
```

### Build Docker Images Localmente

```bash
# Backend
docker build -t anpr-backend ./backend

# ANPR Service
docker build -t anpr-service ./services/anpr

# Frontend
docker build -t anpr-frontend ./frontend
```

### Ejecutar Pipeline Localmente

```bash
# Usar act para ejecutar GitHub Actions localmente
brew install act  # macOS
# o
choco install act-cli  # Windows

act push  # Simular push
act pull_request  # Simular PR
```

## Monitoreo del Pipeline

### Ver Estado de Workflows

1. Ir a la pestaña "Actions" en GitHub
2. Ver workflows en ejecución
3. Revisar logs de cada job
4. Ver artefactos generados

### Notificaciones

Configurar notificaciones en:
- GitHub Actions notifications
- Slack (webhook configurado)
- Email (GitHub notifications)

## Troubleshooting

### Tests Fallando

**Síntoma**: Job de tests falla

**Solución**:
1. Revisar logs del job
2. Ejecutar tests localmente
3. Verificar dependencias
4. Revisar configuración de tests

### Docker Build Fallando

**Síntoma**: Job de Docker build falla

**Solución**:
1. Revisar logs del build
2. Verificar Dockerfile
3. Verificar dependencias
4. Revisar credenciales de Docker Hub

### Deployment Fallando

**Símtoma**: Job de deployment falla

**Solución**:
1. Revisar logs de kubectl
2. Verificar configuración de Kubernetes
3. Verificar secrets de kubeconfig
4. Revisar manifests de Kubernetes

### Coverage Bajo

**Síntoma**: Coverage debajo del umbral

**Solución**:
1. Agregar más tests
2. Revisar código no testeado
3. Ajustar configuración de coverage
4. Priorizar código crítico

## Mejores Prácticas

### Branch Strategy

- `main`: Branch de producción
- `develop`: Branch de desarrollo
- `feature/*`: Branches para nuevas features
- `hotfix/*`: Branches para correcciones urgentes

### Commits

- Usar commits descriptivos
- Seguir conventional commits
- Agregar issue numbers en commits
- Evitar commits grandes

### Code Review

- Requerir approval para PRs
- Usar GitHub protections
- Ejecutar CI en PRs
- Revisar cambios manualmente

### Rollback

- Tener plan de rollback
- Automatizar rollback en CD
- Mantener backups recientes
- Documentar procedimientos

## Seguridad

### Secrets Management

- Nunca hardcodear secrets
- Usar GitHub Secrets
- Rotar secrets regularmente
- Usar least privilege

### Dependency Scanning

- Escanear dependencias regularmente
- Actualizar dependencias
- Usar Dependabot
- Revisar advisories

### Container Security

- Escanear imágenes Docker
- Usar imágenes base oficiales
- Minimizar tamaño de imágenes
- No incluir secrets en imágenes

## Referencias

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Docker Build Push Action](https://github.com/docker/build-push-action)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Codecov Documentation](https://docs.codecov.com/)