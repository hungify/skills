<script setup lang="ts">
type ButtonVariant = 'filled' | 'outline';

withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    disabled?: boolean;
    label: string;
    'aria-label'?: string;
  }>(),
  {
    variant: 'filled',
    disabled: false,
  },
);

defineEmits<{
  click: [];
  submit: [payload: { source: string }];
}>();

defineSlots<{
  default(): unknown;
  prepend(): unknown;
}>();

defineModel<string>();
</script>

<template>
  <button :disabled="disabled" :aria-label="aria-label">
    <slot name="prepend" />
    {{ label }}
    <slot />
  </button>
</template>
