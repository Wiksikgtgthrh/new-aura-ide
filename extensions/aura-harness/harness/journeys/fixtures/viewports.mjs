// journeys/fixtures/viewports.mjs — единые вьюпорты для всех journeys.
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

export function viewport(name) {
  const v = VIEWPORTS[name];
  if (!v) throw new Error(`неизвестный viewport «${name}», есть: ${Object.keys(VIEWPORTS).join(', ')}`);
  return v;
}
