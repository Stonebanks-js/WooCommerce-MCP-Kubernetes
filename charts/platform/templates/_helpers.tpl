{{/*
Naming. contracts.md section 2 fixes the in-cluster names as <release>-<component>
(platform-gateway, platform-postgres, platform-mcp-notes, ...), so the "fullname" is the release
name (optionally overridden), not <release>-<chart>.
*/}}
{{- define "platform.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels. Pass (dict "root" . "component" "gateway"). app.kubernetes.io/name is the component
and app.kubernetes.io/instance the release: the pair every NetworkPolicy (here and in the store
chart, which admits app.kubernetes.io/name=gateway pods) keys on.
*/}}
{{- define "platform.labels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: urumi-mcp-platform
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ include "platform.chart" .root }}
{{- end -}}

{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* Public scheme: https as soon as the Ingress has a TLS block, otherwise .Values.publicScheme. */}}
{{- define "platform.scheme" -}}
{{- if .Values.ingress.tls -}}https{{- else -}}{{ .Values.publicScheme | default "http" }}{{- end -}}
{{- end -}}

{{/* PUBLIC_URL for the gateway: invite links, the "connect" page and the MCP Origin check. */}}
{{- define "platform.publicUrl" -}}
{{ include "platform.scheme" . }}://{{ .Values.host }}
{{- end -}}

{{- define "platform.image" -}}
{{- if .registry -}}{{ .registry }}/{{ .image.repository }}:{{ .image.tag }}{{- else -}}{{ .image.repository }}:{{ .image.tag }}{{- end -}}
{{- end -}}

{{/* Hardened container securityContext shared by every Node/nginx workload in this chart. */}}
{{- define "platform.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/*
One upstream MCP server (apps/extra-mcp, image urumi/extra-mcp): Deployment + ClusterIP Service +
Secret. Called as (dict "root" . "name" "mcp-notes" "server" "notes" "values" .Values.mcpNotes
"token" <secret value>). ClusterIP only, no Ingress: only the gateway talks to these (see
networkpolicy.yaml). SERVER=notes|utils selects the entrypoint inside the shared image.
*/}}
{{- define "platform.mcpServer" -}}
{{- $root := .root -}}
{{- $name := .name -}}
{{- $v := .values -}}
{{- $full := printf "%s-%s" (include "platform.fullname" $root) $name -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $full }}
  labels:
    {{- include "platform.labels" (dict "root" $root "component" $name) | nindent 4 }}
type: Opaque
stringData:
  MCP_AUTH_TOKEN: {{ .token | quote }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $full }}
  labels:
    {{- include "platform.labels" (dict "root" $root "component" $name) | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "platform.selectorLabels" (dict "root" $root "component" $name) | nindent 4 }}
  ports:
    - name: http
      port: 8080
      targetPort: http
      protocol: TCP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $full }}
  labels:
    {{- include "platform.labels" (dict "root" $root "component" $name) | nindent 4 }}
spec:
  replicas: {{ $v.replicas }}
  selector:
    matchLabels:
      {{- include "platform.selectorLabels" (dict "root" $root "component" $name) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "platform.labels" (dict "root" $root "component" $name) | nindent 8 }}
      annotations:
        checksum/token: {{ .token | sha256sum }}
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000      # "node" user of node:22-alpine
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: {{ $name }}
          image: {{ include "platform.image" (dict "image" $v.image "registry" $root.Values.global.imageRegistry) }}
          imagePullPolicy: {{ $v.image.pullPolicy }}
          env:
            - name: PORT
              value: "8080"
            - name: SERVER
              value: {{ .server | quote }}
            - name: LOG_LEVEL
              value: {{ $v.logLevel | default "info" | quote }}
            - name: MCP_AUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ $full }}
                  key: MCP_AUTH_TOKEN
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 15
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            initialDelaySeconds: 3
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            {{- toYaml $v.resources | nindent 12 }}
          securityContext:
            {{- include "platform.containerSecurityContext" $root | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
{{- end -}}
