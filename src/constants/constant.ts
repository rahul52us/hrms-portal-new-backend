const getLevelForNotifcation = (numberOfLevels: number, currentLevel: string): string => {
  const levels = Array.from({ length: numberOfLevels }, (_, index) => `level-${index + 1}`);
  if (currentLevel === levels[levels.length - 1]) {
    return "admin";
  }
  const currentIndex = levels.findIndex(level => level === currentLevel);
  if (currentIndex === -1) {
    return levels[0];
  }
  return levels[currentIndex + 1];
};

function generateLevels(numLevels: number): string[] {
  const levels: string[] = [];
  for (let i = 1; i <= numLevels; i++) {
      levels.push(`level-${i}`);
  }
  levels.unshift('admin');
  return levels;
}

export {getLevelForNotifcation, generateLevels}