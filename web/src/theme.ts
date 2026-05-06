export interface Theme {
  bg: string; surface: string; surfaceAlt: string; border: string
  text: string; textDim: string; textFaint: string; inputBg: string
}

export const dark: Theme = {
  bg: '#0D0B08', surface: '#1A1814', surfaceAlt: '#252118', border: '#1A1814',
  text: '#E8E4DC', textDim: '#666', textFaint: '#333', inputBg: '#1A1814',
}

export const light: Theme = {
  bg: '#F5F0E8', surface: '#FFFFFF', surfaceAlt: '#EDE8DF', border: '#DDD8CF',
  text: '#1A1814', textDim: '#888', textFaint: '#CCC', inputBg: '#FFFFFF',
}
