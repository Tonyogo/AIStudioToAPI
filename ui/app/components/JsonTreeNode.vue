<template>
    <div class="json-tree-node" :style="{ paddingLeft: depth > 0 ? '16px' : '0' }">
        <!-- Object/Array Node -->
        <div v-if="isObject" class="json-tree-row">
            <span class="tree-toggle-arrow" :class="{ 'is-expanded': expanded }" @click.stop="toggleExpand">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
            </span>
            <span v-if="name !== ''" class="tree-key" @click.stop="toggleExpand">{{ name }}:</span>
            <span class="tree-bracket-summary" @click.stop="toggleExpand">
                {{ bracketSummary }}
                <span v-if="!expanded && count > 0" class="tree-item-count">{{ count }} {{ countText }}</span>
            </span>
        </div>

        <!-- Children of Object/Array (only rendered if expanded) -->
        <div v-if="isObject && expanded" class="tree-children">
            <json-tree-node
                v-for="(childVal, childKey, idx) in val"
                :key="childKey"
                :name="isArray ? idx : childKey"
                :val="childVal"
                :depth="depth + 1"
                :is-last="idx === count - 1"
            />
        </div>

        <!-- Primitive Value Node -->
        <div v-if="!isObject" class="json-tree-row is-primitive">
            <span v-if="name !== ''" class="tree-key">{{ name }}:</span>

            <!-- Color-coded highlighters -->
            <span v-if="type === 'string'" class="tree-value is-string">
                <el-tooltip v-if="isLongString" placement="top" effect="dark" :show-after="200" raw-content>
                    <template #content>
                        <div class="tree-tooltip-full-text">{{ val }}</div>
                    </template>
                    <span class="long-string-text">"{{ truncatedString }}"</span>
                </el-tooltip>
                <span v-else>"{{ val }}"</span>
            </span>
            <span v-else-if="type === 'number'" class="tree-value is-number">{{ val }}</span>
            <span v-else-if="type === 'boolean'" class="tree-value is-boolean">{{ val }}</span>
            <span v-else-if="type === 'null'" class="tree-value is-null">null</span>

            <span v-if="!isLast" class="tree-comma">,</span>
        </div>

        <!-- Closing brackets for objects/arrays -->
        <div v-if="isObject && expanded" class="tree-bracket-closing">
            {{ isArray ? "]" : "}" }}{{ !isLast ? "," : "" }}
        </div>
    </div>
</template>

<script setup>
import { computed, ref } from "vue";

const props = defineProps({
    depth: { type: Number, default: 0 },
    isLast: { type: Boolean, default: true },
    name: { type: [String, Number], default: "" },
    val: { type: null, required: true },
});

const expanded = ref(props.depth <= 1);

const toggleExpand = () => {
    expanded.value = !expanded.value;
};

const isObject = computed(() => typeof props.val === "object" && props.val !== null);
const isArray = computed(() => Array.isArray(props.val));

const type = computed(() => {
    if (props.val === null) return "null";
    return typeof props.val;
});

const count = computed(() => {
    if (!isObject.value) return 0;
    if (isArray.value) return props.val.length;
    return Object.keys(props.val).length;
});

const countText = computed(() => (isArray.value ? "items" : "keys"));

const bracketSummary = computed(() => {
    if (isArray.value) {
        return expanded.value ? "[" : "[ ... ]";
    }
    return expanded.value ? "{" : "{ ... }";
});

const isLongString = computed(() => type.value === "string" && props.val.length > 80);
const truncatedString = computed(() => {
    if (!isLongString.value) return props.val;
    return props.val.substring(0, 80) + "...";
});
</script>

<style lang="less" scoped>
.json-tree-node {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: #ffd700;
}
.json-tree-row {
    display: flex;
    align-items: flex-start;
    padding: 1px 0;
    cursor: default;
    user-select: text;

    &.is-primitive {
        padding-left: 16px; /* align with arrows */
    }
}
.tree-toggle-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    cursor: pointer;
    color: #808080;
    transition: transform 0.15s ease;

    svg {
        width: 10px;
        height: 10px;
    }

    &.is-expanded {
        transform: rotate(90deg);
    }
}
.tree-key {
    color: #9cdcfe; /* light blue */
    margin-right: 6px;
    font-weight: 500;
    cursor: pointer;
}
.tree-bracket-summary {
    color: #ffd700; /* gold */
    cursor: pointer;
}
.tree-item-count {
    font-size: 11px;
    color: #808080;
    background: #2d2d2d;
    padding: 1px 6px;
    border-radius: 4px;
    margin-left: 6px;
}
.tree-children {
    display: flex;
    flex-direction: column;
}
.tree-bracket-closing {
    color: #ffd700;
    padding-left: 16px;
}
.tree-value {
    &.is-string {
        color: #ce9178; /* orange string */
        word-break: break-all;
        white-space: pre-wrap;
    }
    &.is-number {
        color: #b5cea8; /* green number */
    }
    &.is-boolean {
        color: #569cd6; /* blue bool */
    }
    &.is-null {
        color: #808080; /* grey null */
    }
}
.tree-comma {
    color: #ffd700;
}
</style>

<style lang="less">
.tree-tooltip-full-text {
    max-width: 400px;
    max-height: 250px;
    overflow-y: auto;
    font-family: Consolas, Monaco, monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
}
</style>
