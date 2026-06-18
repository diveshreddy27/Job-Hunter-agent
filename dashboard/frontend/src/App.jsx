import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Overview from './pages/Overview'
import Analytics from './pages/Analytics'
import Jobs from './pages/Jobs'
import AtsDetail from './pages/AtsDetail'
import AppliedAnalysis from './pages/AppliedAnalysis'
import SkillsGap from './pages/SkillsGap'
import Recruiters from './pages/Recruiters'
import Outreach from './pages/Outreach'
import ProfileFields from './pages/ProfileFields'
import RawData from './pages/RawData'

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/leaderboard" element={<Navigate to="/jobs" replace />} />
          <Route path="/ats/:id" element={<AtsDetail />} />
          <Route path="/applied" element={<AppliedAnalysis />} />
          <Route path="/skills-gap" element={<SkillsGap />} />
          <Route path="/recruiters" element={<Recruiters />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/profile-fields" element={<ProfileFields />} />
          <Route path="/raw-data" element={<RawData />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
