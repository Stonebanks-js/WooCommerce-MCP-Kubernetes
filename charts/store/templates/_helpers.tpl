{{/*
Naming. The contract (docs/contracts.md section 2) fixes the in-cluster names as
<release>-<component> (e.g. demo-wordpress, demo-mariadb, demo-woo-mcp), so the "fullname" is
simply the release name (optionally overridden), NOT the usual <release>-<chart>.
*/}}
{{- define "store.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "store.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels for every object. Pass a dict: (dict "root" . "component" "wordpress").
app.kubernetes.io/name and app.kubernetes.io/instance are the pair the NetworkPolicies key on
(contracts section 2), so they must be exactly <component> and <release>.
*/}}
{{- define "store.labels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: urumi-store
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ include "store.chart" .root }}
{{- end -}}

{{/* Selector labels: the immutable subset (never add chart version here). */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* Public scheme: https as soon as the Ingress carries a TLS block, otherwise store.scheme. */}}
{{- define "store.scheme" -}}
{{- if .Values.ingress.tls -}}https{{- else -}}{{ .Values.store.scheme | default "http" }}{{- end -}}
{{- end -}}

{{/* Public storefront URL, used for WP_HOME / WP_SITEURL, the install URL and woo-mcp's STORE_URL. */}}
{{- define "store.publicUrl" -}}
{{ include "store.scheme" . }}://{{ .Values.store.host }}
{{- end -}}

{{/* In-cluster WordPress origin (Service DNS short name resolves inside the namespace). */}}
{{- define "store.wordpressInternalUrl" -}}
http://{{ include "store.fullname" . }}-wordpress:80
{{- end -}}

{{/*
Environment shared by the WordPress container, the setup Job's init container and its wp-cli
container. wp-config-docker.php (shipped in the image) reads WORDPRESS_DB_* on EVERY request, so
anything that loads WordPress from the shared PVC needs the same variables.
WORDPRESS_CONFIG_EXTRA is eval'd before plugin.php loads: only define()s belong in it.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ include "store.fullname" . }}-mariadb:3306
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.fullname" . }}-db
      key: password
- name: WORDPRESS_TABLE_PREFIX
  value: {{ .Values.wordpress.tablePrefix | quote }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |-
    define('WP_HOME', '{{ include "store.publicUrl" . }}');
    define('WP_SITEURL', '{{ include "store.publicUrl" . }}');
    {{- with .Values.wordpress.configExtra }}
    {{ . | nindent 4 }}
    {{- end }}
{{- end -}}

{{/* Image reference helper: (dict "image" .Values.x.image "registry" .Values.global.imageRegistry) */}}
{{- define "store.image" -}}
{{- $reg := .registry -}}
{{- if $reg -}}{{ $reg }}/{{ .image.repository }}:{{ .image.tag }}{{- else -}}{{ .image.repository }}:{{ .image.tag }}{{- end -}}
{{- end -}}
