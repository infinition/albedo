//! Small shared helpers.

/// Union-find with path halving and union by size.
///
/// Used to group triangles into smoothing islands, and later to merge segments.
#[derive(Clone, Debug)]
pub struct UnionFind {
    parent: Vec<u32>,
    size: Vec<u32>,
}

impl UnionFind {
    pub fn new(n: usize) -> Self {
        Self {
            parent: (0..n as u32).collect(),
            size: vec![1; n],
        }
    }

    pub fn len(&self) -> usize {
        self.parent.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    pub fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            // Path halving: cheaper than full compression and just as effective
            // here, where find is called far more often than union.
            let grand = self.parent[self.parent[x as usize] as usize];
            self.parent[x as usize] = grand;
            x = grand;
        }
        x
    }

    /// Returns true when the two elements were in different sets.
    pub fn union(&mut self, a: u32, b: u32) -> bool {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return false;
        }
        if self.size[ra as usize] < self.size[rb as usize] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb as usize] = ra;
        self.size[ra as usize] += self.size[rb as usize];
        true
    }

    pub fn set_size(&mut self, x: u32) -> u32 {
        let r = self.find(x);
        self.size[r as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_find_merges_and_counts() {
        let mut uf = UnionFind::new(6);
        assert!(uf.union(0, 1));
        assert!(uf.union(1, 2));
        assert!(!uf.union(0, 2));
        assert_eq!(uf.find(0), uf.find(2));
        assert_ne!(uf.find(0), uf.find(3));
        assert_eq!(uf.set_size(1), 3);
    }
}
