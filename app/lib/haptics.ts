import * as Haptics from 'expo-haptics';
export const impact = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
